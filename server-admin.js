const express = require("express");
const cors    = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

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
app.post("/auth/login", async (req, res) => {
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
    await logAction(user.id, "LOGIN", "admin", null, { email: user.email });

    await supabase.from("nguoi_dung")
      .update({ lan_dang_nhap_cuoi: new Date().toISOString() })
      .eq("id", user.id);

    res.json({ userId: user.id, name: user.ho_ten, email: user.email, role: "admin" });
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
    await logAction(userId, "CHANGE_PASSWORD", "admin", null, {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPER — GHI NHẬT KÝ
// ============================================================
async function logAction(userId, action, targetType, targetId, detail) {
  try {
    await supabase.from("nhat_ky_he_thong").insert({
      nguoi_dung_id: userId,
      hanh_dong:     action,
      loai_doi_tuong: targetType,
      doi_tuong_id:  targetId || null,
      chi_tiet:      JSON.stringify(detail || {}),
      thoi_gian:     new Date().toISOString(),
    });
  } catch (_) { /* Không throw — nhật ký không được làm gián đoạn nghiệp vụ */ }
}

// ============================================================
// DASHBOARD TỔNG QUAN
// ============================================================

// GET /dashboard
app.get("/dashboard", async (req, res) => {
  try {
    const [hsResult, devResult, ptResult, alertResult] = await Promise.all([
      supabase.from("co_so_y_te").select("id, trang_thai_hoat_dong").eq("trang_thai_hoat_dong", true),
      supabase.from("thiet_bi_iot").select("id, trang_thai_hoat_dong, lan_online_cuoi"),
      supabase.from("lich_su_gan_thiet_bi").select("id").eq("trang_thai_hoat_dong", true),
      supabase.from("canh_bao_suc_khoe")
        .select("id, muc_do_nghiem_trong")
        .gte("thoi_gian_phat_hien", new Date(Date.now() - 86400000).toISOString()),
    ]);

    const now = Date.now();
    const devices = devResult.data || [];
    const onlineCount = devices.filter(d =>
      d.lan_online_cuoi && now - new Date(d.lan_online_cuoi).getTime() < 60000
    ).length;

    res.json({
      hospitals:      { total: (hsResult.data || []).length },
      devices: {
        total:   devices.length,
        online:  onlineCount,
        offline: devices.length - onlineCount,
      },
      patients:       { total: (ptResult.data || []).length },
      alerts: {
        total:   (alertResult.data || []).length,
        danger:  (alertResult.data || []).filter(a => a.muc_do_nghiem_trong === "nguy_hiem").length,
        warning: (alertResult.data || []).filter(a => a.muc_do_nghiem_trong === "canh_bao").length,
      },
    });
  } catch (err) {
    console.error("[GET /dashboard]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CƠ SỞ Y TẾ
// ============================================================

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

    await logAction(adminId, "CREATE_HOSPITAL", "co_so_y_te", data.id, { name: data.ten_co_so });
    res.json({ hospitalId: data.id, name: data.ten_co_so });
  } catch (err) {
    console.error("[POST /hospitals]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /hospitals/:id — cập nhật CSYT
app.patch("/hospitals/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId, name, address, phone, email, type, active } = req.body;

    const updates = {};
    if (name !== undefined)    updates.ten_co_so           = name;
    if (address !== undefined) updates.dia_chi              = address;
    if (phone !== undefined)   updates.so_dien_thoai        = phone;
    if (email !== undefined)   updates.email_lien_he        = email;
    if (type !== undefined)    updates.loai_hinh            = type;
    if (active !== undefined)  updates.trang_thai_hoat_dong = active;

    const { error } = await supabase.from("co_so_y_te").update(updates).eq("id", id);
    if (error) throw error;

    await logAction(adminId, "UPDATE_HOSPITAL", "co_so_y_te", id, updates);
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

    await logAction(adminId, "CREATE_SUBADMIN", "nguoi_dung", newUser.id, { name, email, hospitalId });
    res.json({ userId: newUser.id, name: name.trim() });
  } catch (err) {
    console.error("[POST /subadmins]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /subadmins/:id — kích hoạt / vô hiệu hóa tài khoản
app.patch("/subadmins/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId, active, password } = req.body;

    const updates = {};
    if (active !== undefined)  updates.trang_thai_hoat_dong = active;
    if (password !== undefined) updates.mat_khau = password;

    await supabase.from("nguoi_dung").update(updates).eq("id", id);
    await logAction(adminId, "UPDATE_SUBADMIN", "nguoi_dung", id, updates);
    res.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /subadmins/:id]", err.message);
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
      online:       d.lan_online_cuoi ? now - new Date(d.lan_online_cuoi).getTime() < 60000 : false,
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

    await logAction(adminId, "CREATE_DEVICE", "thiet_bi_iot", data.id, { serial, hospitalId });
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
    const { page = 1, limit = 50, action, userId } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase.from("nhat_ky_he_thong")
      .select("id, nguoi_dung_id, hanh_dong, loai_doi_tuong, doi_tuong_id, chi_tiet, thoi_gian")
      .order("thoi_gian", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (action) query = query.eq("hanh_dong", action);
    if (userId) query = query.eq("nguoi_dung_id", userId);

    const { data, error } = await query;
    if (error) throw error;

    // Lấy tên người dùng
    const uids = [...new Set((data||[]).map(l => l.nguoi_dung_id).filter(Boolean))];
    const uMap = {};
    if (uids.length) {
      const { data: users } = await supabase.from("nguoi_dung").select("id, ho_ten, email").in("id", uids);
      (users||[]).forEach(u => { uMap[u.id] = { name: u.ho_ten, email: u.email }; });
    }

    res.json((data||[]).map(l => ({
      id:         l.id,
      userId:     l.nguoi_dung_id,
      userName:   uMap[l.nguoi_dung_id]?.name || '—',
      userEmail:  uMap[l.nguoi_dung_id]?.email || '—',
      action:     l.hanh_dong,
      targetType: l.loai_doi_tuong,
      targetId:   l.doi_tuong_id,
      detail:     l.chi_tiet,
      time:       l.thoi_gian,
    })));
  } catch (err) {
    console.error("[GET /logs]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log("👑 HealthMonitor Admin API v1.0 — port " + PORT);
});

process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException",  (e) => { console.error("[uncaughtException]", e); process.exit(1); });
