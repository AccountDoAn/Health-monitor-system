const express = require("express");
const cors    = require("cors");
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

const FRONTEND_URL = 'https://accountdoan.github.io/Health-monitor-system';

async function sendEmail({ to, subject, html }){
  const apiKey = process.env.BREVO_API_KEY;
  if(!apiKey) throw new Error('Thiếu BREVO_API_KEY');
  const res = await fetch('https://api.brevo.com/v3/smtp/email',{
    method:'POST',
    headers:{'Content-Type':'application/json','api-key':apiKey},
    body: JSON.stringify({
      sender:{ name:'Health Monitor', email:'no-reply@healthmonitor.vn' },
      to:[{ email:to }], subject, htmlContent:html,
    })
  });
  if(!res.ok) throw new Error('Brevo error '+res.status);
  return await res.json();
}

// Rate limit cho login - tối đa 10 lần/15 phút/IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau 15 phút.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit chung cho API - tối đa 200 request/phút/IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' },
  standardHeaders: true,
  legacyHeaders: false,
});


const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set('trust proxy', 1); // Cần cho Render/proxy

// ===== CORS =====
const corsOptions = {
  origin: function(origin, callback) {
    const allowed = [
      "https://accountdoan.github.io",
      "http://localhost:3000",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ];
    if (!origin || allowed.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(apiLimiter);
app.options("*", cors(corsOptions));
app.use(express.json());

// ===== Supabase =====
const supabase = createClient(
  "https://czgberdpnfultxkljhko.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6Z2JlcmRwbmZ1bHR4a2xqaGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3OTY3MTEsImV4cCI6MjA5MDM3MjcxMX0.H9pv62PGbIJqJNK72yGEGB1Y9yw7HPEvk82zdxlgVYg"
);

// ===== Health check =====
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "HealthMonitor Admin API", version: "1.0" });
});

// ============================================================
// AUTH
// ============================================================

// POST /auth/login — chỉ cho role admin
app.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password)
      return res.status(400).json({ error: "Vui lòng nhập email và mật khẩu" });

    const isEmail = login.includes("@");
    const field   = isEmail ? "email" : "so_dien_thoai";

    const { data: users, error } = await supabase
      .from("nguoi_dung")
      .select("id, ho_ten, email, so_dien_thoai, mat_khau, co_so_y_te_id, trang_thai_hoat_dong")
      .eq(field, login)
      .eq("trang_thai_hoat_dong", true)
      .limit(1);
    if (error) throw error;
    if (!users || !users.length)
      return res.status(401).json({ error: "Tài khoản không tồn tại hoặc đã bị khoá" });

    const user = users[0];
    if (user.mat_khau !== password)
      return res.status(401).json({ error: "Mật khẩu không đúng" });

    // Kiểm tra đúng role admin
    const { data: pq } = await supabase
      .from("phan_quyen_nguoi_dung")
      .select("vai_tro(ten_vai_tro)")
      .eq("nguoi_dung_id", user.id);
    const roles = (pq || []).map(p => p.vai_tro?.ten_vai_tro).filter(Boolean);
    if (!roles.includes("admin"))
      return res.status(403).json({ error: "Tài khoản không có quyền truy cập trang Admin" });

    // Admin không được gắn CSYT
    if (user.co_so_y_te_id)
      return res.status(403).json({ error: "Tài khoản Admin không hợp lệ" });

    // Ghi nhật ký đăng nhập
    await logAction(user.id, "LOGIN", "admin", null, { email: user.email }, getIp(req));

    await supabase.from("nguoi_dung")
      .update({ lan_dang_nhap_cuoi: new Date().toISOString() })
      .eq("id", user.id);

    res.json({ userId: user.id, name: user.ho_ten, email: user.email, role: "admin", roles: ["admin"] });
  } catch (err) {
    console.error("[POST /auth/login]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/change-password
app.post("/auth/change-password", async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) return res.status(400).json({ error: "Thiếu thông tin" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Mật khẩu phải ≥ 6 ký tự" });
    await supabase.from("nguoi_dung").update({ mat_khau: newPassword }).eq("id", userId);
    await logAction(userId, "CHANGE_PASSWORD", "admin", null, {}, getIp(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPER — GHI NHẬT KÝ
// ============================================================

function getIp(req){
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
}

async function logAction(userId, action, targetType, targetId, detail, ip) {
  try {
    await supabase.from("nhat_ky_he_thong").insert({
      nguoi_dung_id:  userId || null,
      hanh_dong:      action,
      loai_doi_tuong: targetType,
      doi_tuong_id:   targetId || null,
      du_lieu_bo_sung: detail || {},
      ngay_tao:       new Date().toISOString(),
    });
  } catch (_) { /* Không throw — nhật ký không được làm gián đoạn nghiệp vụ */ }
}

// ============================================================
// DASHBOARD TỔNG QUAN
// ============================================================

// GET /dashboard
app.get("/dashboard", async (req, res) => {
  try {
    const [hsResult, devResult, saResult] = await Promise.all([
      supabase.from("co_so_y_te").select("id").eq("trang_thai_hoat_dong", true),
      supabase.from("thiet_bi_iot").select("id, lan_online_cuoi"),
      supabase.from("vai_tro").select("id").eq("ten_vai_tro","sub_admin").maybeSingle()
        .then(async ({data:role}) => {
          if(!role) return {data:[]};
          return supabase.from("phan_quyen_nguoi_dung").select("nguoi_dung_id").eq("vai_tro_id",role.id);
        }),
    ]);

    const now = Date.now();
    const devices = devResult.data || [];
    const onlineCount  = devices.filter(d => d.trang_thai_hoat_dong === true).length;
    const offlineCount = devices.length - onlineCount;

    res.json({
      hospitals:  { total: (hsResult.data || []).length },
      devices:    { total: devices.length, online: onlineCount, offline: offlineCount },
      subadmins:  { total: (saResult.data || []).length },
    });
  } catch (err) {
    console.error("[GET /dashboard]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CƠ SỞ Y TẾ
// ============================================================

// POST /auth/forgot-password
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if(!email) return res.status(400).json({ error:"Vui lòng nhập email" });
    const { data: users } = await supabase.from("nguoi_dung")
      .select("id, ho_ten, email, trang_thai_hoat_dong")
      .eq("email", email.trim().toLowerCase())
      .eq("trang_thai_hoat_dong", true).limit(1);
    if(!users?.length) return res.json({ message:"Nếu email tồn tại, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu." });
    const user  = users[0];
    const token = crypto.randomBytes(32).toString("hex");
    const hetHan = new Date(Date.now() + 60*60*1000);
    await supabase.from("reset_password_token").delete().eq("nguoi_dung_id",user.id).eq("da_su_dung",false);
    await supabase.from("reset_password_token").insert({ nguoi_dung_id:user.id, token, het_han:hetHan.toISOString(), da_su_dung:false });
    const resetLink = `${FRONTEND_URL}/reset-password.html?token=${token}`;
    await sendEmail({ to:user.email, subject:"🔐 Đặt lại mật khẩu — Health Monitor", html:`
      <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f0f7f4;border-radius:16px">
        <div style="background:#fff;border-radius:12px;padding:28px 24px;border:1px solid #d0e8da">
          <h2 style="color:#2b5f8e;margin:0 0 8px">Đặt lại mật khẩu</h2>
          <p>Xin chào <strong>${user.ho_ten}</strong>,</p>
          <p>Nhấn vào nút bên dưới để đặt lại mật khẩu. Link có hiệu lực trong <strong>1 giờ</strong>.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${resetLink}" style="background:#2b5f8e;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700">✅ Đặt lại mật khẩu</a>
          </div>
          <p style="font-size:.8rem;color:#6b8f7a">Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>
        </div>
      </div>` });
    res.json({ message:"Nếu email tồn tại, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu." });
  } catch(err){
    console.error("[POST /auth/forgot-password]", err.message);
    res.status(500).json({ error:err.message });
  }
});

// GET /auth/verify-reset-token/:token
app.get("/auth/verify-reset-token/:token", async (req, res) => {
  try {
    const { data } = await supabase.from("reset_password_token")
      .select("id, nguoi_dung_id, het_han, da_su_dung")
      .eq("token", req.params.token).maybeSingle();
    if(!data || data.da_su_dung || new Date(data.het_han) < new Date())
      return res.status(400).json({ valid:false, error:"Token không hợp lệ hoặc đã hết hạn" });
    res.json({ valid:true, userId:data.nguoi_dung_id });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// POST /auth/reset-password
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if(!token||!password||password.length<6) return res.status(400).json({ error:"Thông tin không hợp lệ" });
    const { data } = await supabase.from("reset_password_token")
      .select("id, nguoi_dung_id, het_han, da_su_dung")
      .eq("token", token).maybeSingle();
    if(!data||data.da_su_dung||new Date(data.het_han)<new Date())
      return res.status(400).json({ error:"Token không hợp lệ hoặc đã hết hạn" });
    await supabase.from("nguoi_dung").update({ mat_khau:password }).eq("id", data.nguoi_dung_id);
    await supabase.from("reset_password_token").update({ da_su_dung:true }).eq("id", data.id);
    res.json({ ok:true });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// POST /auth/logout
app.post("/auth/logout", async (req, res) => {
  try {
    const { userId } = req.body;
    if(userId) await logAction(userId,'LOGOUT','admin',userId,{},getIp(req));
    res.json({ ok: true });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

// GET /hospitals — danh sách tất cả CSYT
app.get("/hospitals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("co_so_y_te")
      .select("id, ten_co_so, dia_chi, so_dien_thoai, email_lien_he, loai_hinh, trang_thai_hoat_dong, ngay_tao")
      .order("ngay_tao", { ascending: false });
    if (error) throw error;

    // Đếm thiết bị và sub-admin mỗi CSYT
    const hsIds = (data || []).map(h => h.id);
    let devCount = {}, subCount = {};

    if (hsIds.length) {
      const [devRes, subRes] = await Promise.all([
        supabase.from("thiet_bi_iot").select("id, co_so_y_te_id").in("co_so_y_te_id", hsIds),
        supabase.from("nguoi_dung").select("id, co_so_y_te_id").in("co_so_y_te_id", hsIds).eq("trang_thai_hoat_dong", true),
      ]);
      (devRes.data || []).forEach(d => { devCount[d.co_so_y_te_id] = (devCount[d.co_so_y_te_id]||0)+1; });
      (subRes.data || []).forEach(u => { subCount[u.co_so_y_te_id] = (subCount[u.co_so_y_te_id]||0)+1; });
    }

    res.json((data || []).map(h => ({
      ...h,
      deviceCount: devCount[h.id] || 0,
      staffCount:  subCount[h.id] || 0,
    })));
  } catch (err) {
    console.error("[GET /hospitals]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /hospitals — tạo CSYT mới
app.post("/hospitals", async (req, res) => {
  try {
    const { adminId, name, address, phone, email, type, maxDevices, contractEnd } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Vui lòng nhập tên cơ sở y tế" });

    const { data, error } = await supabase.from("co_so_y_te").insert({
      ten_co_so:       name.trim(),
      dia_chi:         address || null,
      so_dien_thoai:   phone || null,
      email_lien_he:   email || null,
      loai_hinh:       type || "benh_vien",
      trang_thai_hoat_dong: true,
      ngay_tao:        new Date().toISOString(),
    }).select("id, ten_co_so").single();
    if (error) throw error;

    await logAction(adminId, "CREATE_HOSPITAL", "co_so_y_te", data.id, { name: data.ten_co_so }, getIp(req));
    res.json({ hospitalId: data.id, name: data.ten_co_so });
  } catch (err) {
    console.error("[POST /hospitals]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /profile/:id — lấy thông tin hồ sơ
app.get("/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from("nguoi_dung")
      .select("id, ho_ten, so_dien_thoai, email, anh_dai_dien_url")
      .eq("id", id).single();
    if(error) throw error;
    res.json({
      name:   data.ho_ten,
      phone:  data.so_dien_thoai,
      email:  data.email,
      avatar: data.anh_dai_dien_url,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /profile — cập nhật hồ sơ cá nhân
app.patch("/profile", async (req, res) => {
  try {
    const { adminId, name, phone, email, avatar } = req.body;
    if(!adminId) return res.status(400).json({ error: "Thiếu adminId" });
    const updates = {};
    if(name?.trim())        updates.ho_ten           = name.trim();
    if(phone !== undefined) updates.so_dien_thoai    = phone||null;
    if(email?.trim())       updates.email            = email.trim();
    if(avatar)              updates.anh_dai_dien_url = avatar;
    const { error } = await supabase.from("nguoi_dung").update(updates).eq("id", adminId);
    if(error) throw error;
    res.json({ ok: true });
  } catch(err) {
    console.error("[PATCH /profile]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /hospitals/:id — cập nhật CSYT
app.patch("/hospitals/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId, name, address, phone, email, type, active } = req.body;

    // Nếu đang dừng hoạt động (active = false) → kiểm tra còn dữ liệu không
    if (active === false) {
      const errors = [];

      // 1. Kiểm tra sub-admin
      const { data: saRole } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","sub_admin").maybeSingle();
      if (saRole) {
        const { data: saUsers } = await supabase.from("nguoi_dung")
          .select("id").eq("co_so_y_te_id", id).eq("trang_thai_hoat_dong", true);
        const saIds = (saUsers||[]).map(u=>u.id);
        if (saIds.length) {
          const { data: saPq } = await supabase.from("phan_quyen_nguoi_dung")
            .select("nguoi_dung_id").eq("vai_tro_id", saRole.id).in("nguoi_dung_id", saIds);
          if (saPq?.length) errors.push(`Còn ${saPq.length} sub-admin`);
        }
      }

      // 2. Kiểm tra bác sĩ
      const { data: bsRole } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_bs").maybeSingle();
      if (bsRole) {
        const { data: bsUsers } = await supabase.from("nguoi_dung")
          .select("id").eq("co_so_y_te_id", id).eq("trang_thai_hoat_dong", true);
        const bsIds = (bsUsers||[]).map(u=>u.id);
        if (bsIds.length) {
          const { data: bsPq } = await supabase.from("phan_quyen_nguoi_dung")
            .select("nguoi_dung_id").eq("vai_tro_id", bsRole.id).in("nguoi_dung_id", bsIds);
          if (bsPq?.length) errors.push(`Còn ${bsPq.length} bác sĩ`);
        }
      }

      // 3. Kiểm tra bệnh nhân (qua thiết bị hoặc trực tiếp)
      const { data: tbRole } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_tb").maybeSingle();
      if (tbRole) {
        const { data: tbUsers } = await supabase.from("nguoi_dung")
          .select("id").eq("co_so_y_te_id", id).eq("trang_thai_hoat_dong", true);
        const tbIds = (tbUsers||[]).map(u=>u.id);
        if (tbIds.length) {
          const { data: tbPq } = await supabase.from("phan_quyen_nguoi_dung")
            .select("nguoi_dung_id").eq("vai_tro_id", tbRole.id).in("nguoi_dung_id", tbIds);
          if (tbPq?.length) errors.push(`Còn ${tbPq.length} bệnh nhân`);
        }
      }

      // 4. Kiểm tra thiết bị còn gán bệnh nhân
      const { data: devices } = await supabase.from("thiet_bi_iot")
        .select("id").eq("co_so_y_te_id", id);
      const devIds = (devices||[]).map(d=>d.id);
      if (devIds.length) {
        const { data: assigns } = await supabase.from("lich_su_gan_thiet_bi")
          .select("id").in("thiet_bi_id", devIds).eq("trang_thai_hoat_dong", true);
        if (assigns?.length) errors.push(`Còn ${assigns.length} thiết bị đang gán bệnh nhân`);
      }

      // 5. Kiểm tra liên kết bác sĩ - bệnh nhân
      if (devIds.length || (tbRole)) {
        const { data: tbAll } = await supabase.from("nguoi_dung")
          .select("id").eq("co_so_y_te_id", id);
        const tbAllIds = (tbAll||[]).map(u=>u.id);
        if (tbAllIds.length) {
          const { data: docLinks } = await supabase.from("lien_ket_bac_si")
            .select("id").in("nguoi_dung_tb_id", tbAllIds).eq("trang_thai_hoat_dong", true);
          if (docLinks?.length) errors.push(`Còn ${docLinks.length} liên kết bác sĩ - bệnh nhân`);

          const { data: famLinks } = await supabase.from("lien_ket_nguoi_nha")
            .select("id").in("nguoi_dung_tb_id", tbAllIds).eq("trang_thai_hoat_dong", true);
          if (famLinks?.length) errors.push(`Còn ${famLinks.length} liên kết người nhà - bệnh nhân`);
        }
      }

      if (errors.length) {
        return res.status(409).json({
          error: "Không thể dừng hoạt động cơ sở y tế",
          reason: "Vẫn còn dữ liệu liên quan chưa được xóa:",
          details: errors,
        });
      }
    }

    const updates = {};
    if (name !== undefined)    updates.ten_co_so           = name;
    if (address !== undefined) updates.dia_chi              = address;
    if (phone !== undefined)   updates.so_dien_thoai        = phone;
    if (email !== undefined)   updates.email_lien_he        = email;
    if (type !== undefined)    updates.loai_hinh            = type;
    if (active !== undefined)  updates.trang_thai_hoat_dong = active;

    const { error } = await supabase.from("co_so_y_te").update(updates).eq("id", id);
    if (error) throw error;

    await logAction(adminId, "UPDATE_HOSPITAL", "co_so_y_te", id, updates, getIp(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /hospitals/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TÀI KHOẢN SUB ADMIN
// ============================================================

// GET /subadmins — danh sách tất cả sub-admin
app.get("/subadmins", async (req, res) => {
  try {
    const { data: role } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","sub_admin").maybeSingle();
    if (!role) return res.json([]);

    const { data: pq } = await supabase.from("phan_quyen_nguoi_dung")
      .select("nguoi_dung_id").eq("vai_tro_id", role.id);
    const ids = (pq || []).map(p => p.nguoi_dung_id);
    if (!ids.length) return res.json([]);

    const { data: users, error } = await supabase.from("nguoi_dung")
      .select("id, ho_ten, email, so_dien_thoai, co_so_y_te_id, trang_thai_hoat_dong, lan_dang_nhap_cuoi")
      .in("id", ids).order("ho_ten");
    if (error) throw error;

    // Lấy tên CSYT
    const hsIds = [...new Set((users||[]).map(u => u.co_so_y_te_id).filter(Boolean))];
    const hsMap = {};
    if (hsIds.length) {
      const { data: hsList } = await supabase.from("co_so_y_te").select("id, ten_co_so").in("id", hsIds);
      (hsList||[]).forEach(h => { hsMap[h.id] = h.ten_co_so; });
    }

    res.json((users||[]).map(u => ({
      id:           u.id,
      name:         u.ho_ten,
      email:        u.email,
      phone:        u.so_dien_thoai,
      hospitalId:   u.co_so_y_te_id,
      hospitalName: hsMap[u.co_so_y_te_id] || '—',
      active:       u.trang_thai_hoat_dong,
      lastLogin:    u.lan_dang_nhap_cuoi,
    })));
  } catch (err) {
    console.error("[GET /subadmins]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /subadmins — tạo tài khoản Sub Admin mới
app.post("/subadmins", async (req, res) => {
  try {
    const { adminId, name, email, phone, password, hospitalId } = req.body;
    if (!name?.trim() || !email?.trim() || !hospitalId)
      return res.status(400).json({ error: "Thiếu thông tin bắt buộc" });

    // Kiểm tra email trùng
    const { data: existing } = await supabase.from("nguoi_dung")
      .select("id").eq("email", email.trim().toLowerCase()).maybeSingle();
    if (existing) return res.status(409).json({ error: "Email đã tồn tại" });

    const { data: newUser, error: userErr } = await supabase.from("nguoi_dung").insert({
      ho_ten:           name.trim(),
      email:            email.trim().toLowerCase(),
      so_dien_thoai:    phone || null,
      mat_khau:         password || "123456",
      co_so_y_te_id:    hospitalId,
      trang_thai_hoat_dong: true,
    }).select("id").single();
    if (userErr) throw userErr;

    const { data: role } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","sub_admin").maybeSingle();
    if (role) await supabase.from("phan_quyen_nguoi_dung").insert({ nguoi_dung_id: newUser.id, vai_tro_id: role.id });

    await logAction(adminId, "CREATE_SUBADMIN", "nguoi_dung", newUser.id, { name, email, hospitalId }, getIp(req));
    res.json({ userId: newUser.id, name: name.trim() });
  } catch (err) {
    console.error("[POST /subadmins]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /subadmins/:id — cập nhật thông tin sub admin
app.patch("/subadmins/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId, active, password, name, email, phone, hospitalId } = req.body;

    const updates = {};
    if (active !== undefined)     updates.trang_thai_hoat_dong = active;
    if (password !== undefined)   updates.mat_khau             = password;
    if (name?.trim())             updates.ho_ten               = name.trim();
    if (email !== undefined)      updates.email                = email||null;
    if (phone !== undefined)      updates.so_dien_thoai        = phone||null;
    if (hospitalId !== undefined) updates.co_so_y_te_id        = hospitalId||null;

    await supabase.from("nguoi_dung").update(updates).eq("id", id);
    await logAction(adminId, "UPDATE_SUBADMIN", "nguoi_dung", id, updates, getIp(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /subadmins/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /subadmins/:id — xóa sub admin
app.delete("/subadmins/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;

    // Lấy CSYT của subadmin
    const { data: saUser } = await supabase.from("nguoi_dung")
      .select("co_so_y_te_id, ho_ten").eq("id", id).maybeSingle();
    const hsId = saUser?.co_so_y_te_id;

    if(hsId){
      // Lấy role IDs
      const { data: roles } = await supabase.from("vai_tro")
        .select("id, ten_vai_tro")
        .in("ten_vai_tro", ["user_tb","user_bs","user_lq"]);
      const roleIds = (roles||[]).map(r=>r.id);

      // Lấy tất cả user thuộc CSYT này
      const { data: usersInHs } = await supabase.from("nguoi_dung")
        .select("id").eq("co_so_y_te_id", hsId).eq("trang_thai_hoat_dong", true)
        .neq("id", id); // Loại trừ chính subadmin

      const userIds = (usersInHs||[]).map(u=>u.id);

      // Kiểm tra còn bệnh nhân/bác sĩ/người nhà không
      let hasData = false;
      if(userIds.length && roleIds.length){
        const { data: pq } = await supabase.from("phan_quyen_nguoi_dung")
          .select("nguoi_dung_id")
          .in("nguoi_dung_id", userIds)
          .in("vai_tro_id", roleIds);
        if(pq?.length) hasData = true;
      }

      // Kiểm tra còn thiết bị gán cho CSYT không
      if(!hasData){
        const { data: devs } = await supabase.from("thiet_bi_iot")
          .select("id").eq("co_so_y_te_id", hsId).limit(1);
        if(devs?.length) hasData = true;
      }

      if(hasData){
        return res.status(400).json({
          error: `Không thể xóa Sub Admin "${saUser.ho_ten}" vì cơ sở y tế vẫn còn dữ liệu (bệnh nhân, bác sĩ, người nhà hoặc thiết bị). Vui lòng xóa hết dữ liệu và cơ sở y tế trước.`
        });
      }

      // Kiểm tra CSYT đã bị xóa/vô hiệu chưa
      const { data: hs } = await supabase.from("co_so_y_te")
        .select("id, trang_thai_hoat_dong").eq("id", hsId).maybeSingle();
      if(hs?.trang_thai_hoat_dong){
        return res.status(400).json({
          error: `Cơ sở y tế của Sub Admin "${saUser.ho_ten}" vẫn đang hoạt động. Vui lòng vô hiệu hóa cơ sở y tế trước.`
        });
      }
    }

    // Đủ điều kiện — xóa subadmin
    await supabase.from("phan_quyen_nguoi_dung").delete().eq("nguoi_dung_id", id);
    await supabase.from("nguoi_dung").update({ trang_thai_hoat_dong: false }).eq("id", id);
    await logAction(adminId, "DELETE_SUBADMIN", "nguoi_dung", id, {name: saUser?.ho_ten}, getIp(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /subadmins/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// THIẾT BỊ (chỉ xem tổng quan, không xem chi tiết y tế)
// ============================================================

// GET /devices — tất cả thiết bị toàn hệ thống
app.get("/devices", async (req, res) => {
  try {
    const { data, error } = await supabase.from("thiet_bi_iot")
      .select("id, so_seri, phan_tram_pin, lan_online_cuoi, trang_thai_hoat_dong, ngay_dang_ky, co_so_y_te_id")
      .order("ngay_dang_ky", { ascending: false });
    if (error) throw error;

    const hsIds = [...new Set((data||[]).map(d => d.co_so_y_te_id).filter(Boolean))];
    const hsMap = {};
    if (hsIds.length) {
      const { data: hsList } = await supabase.from("co_so_y_te").select("id, ten_co_so").in("id", hsIds);
      (hsList||[]).forEach(h => { hsMap[h.id] = h.ten_co_so; });
    }

    const now = Date.now();
    res.json((data||[]).map(d => ({
      id:           d.id,
      serial:       d.so_seri,
      battery:      d.phan_tram_pin,
      online: d.trang_thai_hoat_dong === true,
      lastOnline:   d.lan_online_cuoi,
      active:       d.trang_thai_hoat_dong,
      registeredAt: d.ngay_dang_ky,
      hospitalId:   d.co_so_y_te_id,
      hospitalName: hsMap[d.co_so_y_te_id] || '—',
    })));
  } catch (err) {
    console.error("[GET /devices]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices — đăng ký thiết bị mới vào kho và gán cho CSYT
app.post("/devices", async (req, res) => {
  try {
    const { adminId, serial, hospitalId, firmware } = req.body;
    if (!serial?.trim() || !hospitalId)
      return res.status(400).json({ error: "Thiếu serial hoặc cơ sở y tế" });

    const { data: existing } = await supabase.from("thiet_bi_iot")
      .select("id").eq("so_seri", serial.trim()).maybeSingle();
    if (existing) return res.status(409).json({ error: `Serial ${serial} đã tồn tại` });

    const { data, error } = await supabase.from("thiet_bi_iot").insert({
      so_seri:          serial.trim(),
      phien_ban_firmware: firmware || null,
      co_so_y_te_id:    hospitalId,
      trang_thai_hoat_dong: true,
      ngay_dang_ky:     new Date().toISOString(),
    }).select("id, so_seri").single();
    if (error) throw error;

    await logAction(adminId, "CREATE_DEVICE", "thiet_bi_iot", data.id, { serial, hospitalId }, getIp(req));
    res.json({ deviceId: data.id, serial: data.so_seri });
  } catch (err) {
    console.error("[POST /devices]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// NHẬT KÝ HỆ THỐNG
// ============================================================

// GET /logs — nhật ký hoạt động (không thể xóa/sửa)
app.get("/logs", async (req, res) => {
  try {
    const { page=1, limit=20, action, target, dateFrom, dateTo } = req.query;
    const offset = (parseInt(page)-1) * parseInt(limit);

    // Lấy danh sách adminIds và subAdminIds
    const [adminRoleRes, saRoleRes] = await Promise.all([
      supabase.from("vai_tro").select("id").eq("ten_vai_tro","admin").maybeSingle(),
      supabase.from("vai_tro").select("id").eq("ten_vai_tro","sub_admin").maybeSingle(),
    ]);
    let adminIds = [], subAdminIds = [];
    if(adminRoleRes.data){
      const { data: pq } = await supabase.from("phan_quyen_nguoi_dung").select("nguoi_dung_id").eq("vai_tro_id", adminRoleRes.data.id);
      adminIds = (pq||[]).map(p=>p.nguoi_dung_id);
    }
    if(saRoleRes.data){
      const { data: pq } = await supabase.from("phan_quyen_nguoi_dung").select("nguoi_dung_id").eq("vai_tro_id", saRoleRes.data.id);
      subAdminIds = (pq||[]).map(p=>p.nguoi_dung_id);
    }

    console.log('[logs] adminIds:', adminIds.length, 'subAdminIds:', subAdminIds, 'subAdminIds count:', subAdminIds.length);

    // Hàm filter: admin → tất cả | sub-admin → chỉ LOGIN/LOGOUT | null → chỉ bảng admin-level
    const ADMIN_TABLES  = ['co_so_y_te','thiet_bi_iot','admin','sub_admin','nguoi_dung'];
    const PASS = (l) => {
      if(l.nguoi_dung_id && adminIds.includes(l.nguoi_dung_id))    return true;
      if(l.nguoi_dung_id && subAdminIds.includes(l.nguoi_dung_id)) return ['LOGIN','LOGOUT'].includes(l.hanh_dong);
      if(!l.nguoi_dung_id) return ADMIN_TABLES.includes(l.loai_doi_tuong);
      return false;
    };

    // Query lấy tất cả rồi filter phía server
    let q = supabase.from("nhat_ky_he_thong")
      .select("id, nguoi_dung_id, hanh_dong, loai_doi_tuong, doi_tuong_id, du_lieu_bo_sung, ngay_tao")
      .order("ngay_tao", { ascending: false });

    if(action)   q = q.eq("hanh_dong", action);
    if(target)   q = q.eq("loai_doi_tuong", target);
    if(dateFrom) q = q.gte("ngay_tao", dateFrom);
    if(dateTo)   q = q.lte("ngay_tao", dateTo+'T23:59:59');

    const { data: allData, error } = await q;
    if(error) throw error;

    const allFiltered = (allData||[]).filter(PASS);
    const trueTotal   = allFiltered.length;
    const filtered    = allFiltered.slice(offset, offset + parseInt(limit));

    const uids = [...new Set(filtered.map(l=>l.nguoi_dung_id).filter(Boolean))];
    const uMap = {};
    if (uids.length) {
      const { data: users } = await supabase.from("nguoi_dung")
        .select("id, ho_ten, email").in("id", uids);
      (users||[]).forEach(u=>{ uMap[u.id]={name:u.ho_ten, email:u.email}; });
    }

    res.json({
      total: trueTotal, page: parseInt(page), limit: parseInt(limit),
      data: filtered.map(l=>({
        id:         l.id,
        userId:     l.nguoi_dung_id,
        userName:   uMap[l.nguoi_dung_id]?.name||null,
        userEmail:  uMap[l.nguoi_dung_id]?.email||null,
        action:     l.hanh_dong,
        targetType: l.loai_doi_tuong,
        targetId:   l.doi_tuong_id,
        detail:     l.du_lieu_bo_sung,
        time:       l.ngay_tao,
      }))
    });
  } catch (err) {
    console.error("[GET /logs]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3002;
// PATCH /devices/:id — sửa thiết bị
app.patch("/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId, serial, hospitalId } = req.body;
    const updates = {};
    if (serial?.trim())           updates.so_seri        = serial.trim();
    if (hospitalId !== undefined) updates.co_so_y_te_id  = hospitalId||null;
    const { error } = await supabase.from("thiet_bi_iot").update(updates).eq("id", id);
    if (error) throw error;
    await logAction(adminId, "UPDATE_DEVICE", "thiet_bi_iot", id, updates, getIp(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /devices/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /devices/:id — xóa thiết bị
app.delete("/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;

    // Kiểm tra thiết bị đang được gán bệnh nhân (trang_thai_hoat_dong = true)
    const { data: activeAssigns } = await supabase.from("lich_su_gan_thiet_bi")
      .select("id").eq("thiet_bi_id", id).eq("trang_thai_hoat_dong", true).limit(1);
    if(activeAssigns?.length)
      return res.status(409).json({ error: "Thiết bị đang được gán cho bệnh nhân. Vui lòng thu hồi trước khi xóa." });

    // Kiểm tra thiết bị đã từng được gán (có lịch sử — ngay_huy_gan NOT NULL)
    const { data: historyAssigns } = await supabase.from("lich_su_gan_thiet_bi")
      .select("id").eq("thiet_bi_id", id).not("ngay_huy_gan", "is", null).limit(1);
    if(historyAssigns?.length)
      return res.status(409).json({ error: "Thiết bị đã có lịch sử gán bệnh nhân và chưa được thu hồi hoàn toàn. Không thể xóa." });

    const { error } = await supabase.from("thiet_bi_iot").delete().eq("id", id);
    if(error) throw error;
    await logAction(adminId, "DELETE_DEVICE", "thiet_bi_iot", id, {}, getIp(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /devices/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("👑 HealthMonitor Admin API v1.0 — port " + PORT);
});

process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException",  (e) => { console.error("[uncaughtException]", e); process.exit(1); });
