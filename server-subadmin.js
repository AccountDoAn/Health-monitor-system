const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== CORS =====
app.use(cors({
  origin: ["https://accountdoan.github.io"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
}));
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
// HELPER — xác minh sub_admin + lấy co_so_y_te_id
// ============================================================
async function getAdminHospital(userId) {
  const { data: user } = await supabase
    .from("nguoi_dung")
    .select("co_so_y_te_id, trang_thai_hoat_dong")
    .eq("id", userId)
    .maybeSingle();
  if (!user || !user.trang_thai_hoat_dong) return null;

  const { data: pq } = await supabase
    .from("phan_quyen_nguoi_dung")
    .select("vai_tro(ten_vai_tro)")
    .eq("nguoi_dung_id", userId);
  const roles = (pq || []).map(p => p.vai_tro?.ten_vai_tro).filter(Boolean);
  if (!roles.includes("sub_admin")) return null;

  return user.co_so_y_te_id || null;
}

// ============================================================
// AUTH
// ============================================================

// POST /admin/auth/login
app.post("/admin/auth/login", async (req, res) => {
  try {
    const { login, password, hospitalId } = req.body;
    if (!login || !password)
      return res.status(400).json({ error: "Vui lòng nhập email/SĐT và mật khẩu" });

    const field = login.includes("@") ? "email" : "so_dien_thoai";
    const { data: users, error } = await supabase
      .from("nguoi_dung")
      .select("id, ho_ten, email, so_dien_thoai, mat_khau, co_so_y_te_id, trang_thai_hoat_dong")
      .eq(field, login.trim())
      .eq("trang_thai_hoat_dong", true)
      .limit(1);
    if (error) throw error;
    if (!users || users.length === 0)
      return res.status(401).json({ error: "Tài khoản không tồn tại hoặc đã bị khoá" });

    const user = users[0];
    if (user.mat_khau !== password)
      return res.status(401).json({ error: "Mật khẩu không đúng" });

    const { data: pq } = await supabase
      .from("phan_quyen_nguoi_dung")
      .select("vai_tro(ten_vai_tro)")
      .eq("nguoi_dung_id", user.id);
    const roles = (pq || []).map(p => p.vai_tro?.ten_vai_tro).filter(Boolean);
    if (!roles.includes("sub_admin"))
      return res.status(403).json({ error: "Tài khoản không có quyền Sub Admin" });

    if (!hospitalId)
      return res.status(400).json({ error: "Vui lòng chọn cơ sở y tế" });
    if (user.co_so_y_te_id !== hospitalId)
      return res.status(403).json({ error: "Cơ sở y tế không khớp với tài khoản" });

    const { data: hospital } = await supabase
      .from("co_so_y_te").select("id, ten_co_so").eq("id", hospitalId).maybeSingle();

    res.json({
      userId:       user.id,
      name:         user.ho_ten,
      email:        user.email,
      role:         "sub_admin",
      hospitalId:   user.co_so_y_te_id,
      hospitalName: hospital?.ten_co_so || "—",
    });
  } catch (err) {
    console.error("[POST /admin/auth/login]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/auth/change-password
app.post("/admin/auth/change-password", async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) return res.status(400).json({ error: "Thiếu thông tin" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Mật khẩu phải >= 6 ký tự" });
    const { error } = await supabase.from("nguoi_dung").update({ mat_khau: newPassword }).eq("id", userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /admin/auth/change-password]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/hospitals
app.get("/admin/hospitals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("co_so_y_te").select("id, ten_co_so, dia_chi")
      .eq("trang_thai_hoat_dong", true).order("ten_co_so");
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TỔNG QUAN
// ============================================================

app.get("/admin/overview/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: devices } = await supabase
      .from("thiet_bi_iot")
      .select("id, so_seri, phan_tram_pin, lan_online_cuoi, trang_thai_hoat_dong")
      .eq("co_so_y_te_id", hsId);

    const now = Date.now();
    const devList = (devices || []).map(d => ({
      id:         d.id,
      serial:     d.so_seri,
      battery:    d.phan_tram_pin,
      online:     d.lan_online_cuoi ? now - new Date(d.lan_online_cuoi).getTime() < 60000 : false,
      lastOnline: d.lan_online_cuoi,
    }));

    const devIds = devList.map(d => d.id);
    let patientCount = 0;
    if (devIds.length) {
      const { data: assigns } = await supabase
        .from("lich_su_gan_thiet_bi").select("nguoi_dung_tb_id")
        .in("thiet_bi_id", devIds).eq("trang_thai_hoat_dong", true);
      patientCount = new Set((assigns || []).map(a => a.nguoi_dung_tb_id)).size;
    }

    const { data: bsRole } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_bs").maybeSingle();
    let doctorCount = 0;
    if (bsRole) {
      const { data: pq } = await supabase.from("phan_quyen_nguoi_dung").select("nguoi_dung_id").eq("vai_tro_id", bsRole.id);
      const bsIds = (pq||[]).map(p=>p.nguoi_dung_id);
      if (bsIds.length) {
        const { data: docs } = await supabase.from("nguoi_dung").select("id")
          .in("id",bsIds).eq("co_so_y_te_id",hsId).eq("trang_thai_hoat_dong",true);
        doctorCount = (docs||[]).length;
      }
    }

    res.json({
      hospitalId: hsId,
      devices: {
        total:      devList.length,
        online:     devList.filter(d=>d.online).length,
        offline:    devList.filter(d=>!d.online).length,
        lowBattery: devList.filter(d=>d.battery!=null&&d.battery<20).length,
        list:       devList,
      },
      patients: { total: patientCount },
      doctors:  { total: doctorCount },
    });
  } catch (err) {
    console.error("[GET /admin/overview]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// THIẾT BỊ
// ============================================================

app.get("/admin/devices/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: devices, error } = await supabase
      .from("thiet_bi_iot")
      .select("id, so_seri, phien_ban_firmware, phan_tram_pin, lan_online_cuoi, trang_thai_hoat_dong, ngay_dang_ky")
      .eq("co_so_y_te_id", hsId).order("ngay_dang_ky", { ascending: false });
    if (error) throw error;

    const devIds = (devices||[]).map(d=>d.id);
    let assignMap = {};
    if (devIds.length) {
      const { data: assigns } = await supabase.from("lich_su_gan_thiet_bi")
        .select("thiet_bi_id, nguoi_dung_tb_id, ngay_gan")
        .in("thiet_bi_id", devIds).eq("trang_thai_hoat_dong", true);
      const ptIds = [...new Set((assigns||[]).map(a=>a.nguoi_dung_tb_id).filter(Boolean))];
      let ptMap = {};
      if (ptIds.length) {
        const { data: pts } = await supabase.from("nguoi_dung").select("id, ho_ten").in("id",ptIds);
        (pts||[]).forEach(p=>{ ptMap[p.id]=p.ho_ten; });
      }
      (assigns||[]).forEach(a=>{
        assignMap[a.thiet_bi_id]={ patientId:a.nguoi_dung_tb_id, patientName:ptMap[a.nguoi_dung_tb_id]||"—", assignedAt:a.ngay_gan };
      });
    }

    const now = Date.now();
    res.json((devices||[]).map(d=>({
      id:           d.id,
      serial:       d.so_seri,
      firmware:     d.phien_ban_firmware,
      battery:      d.phan_tram_pin,
      online:       d.lan_online_cuoi ? now-new Date(d.lan_online_cuoi).getTime()<60000 : false,
      lastOnline:   d.lan_online_cuoi,
      active:       d.trang_thai_hoat_dong,
      registeredAt: d.ngay_dang_ky,
      assigned:     assignMap[d.id] || null,
    })));
  } catch (err) {
    console.error("[GET /admin/devices]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/devices/register/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { serial, firmware } = req.body;
    if (!serial?.trim()) return res.status(400).json({ error: "Vui lòng nhập số serial" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: existing } = await supabase.from("thiet_bi_iot").select("id").eq("so_seri",serial.trim()).maybeSingle();
    if (existing) return res.status(409).json({ error: `Serial "${serial.trim()}" đã tồn tại` });

    const { data, error } = await supabase.from("thiet_bi_iot").insert({
      so_seri: serial.trim(), phien_ban_firmware: firmware||null,
      co_so_y_te_id: hsId, trang_thai_hoat_dong: true, ngay_dang_ky: new Date().toISOString(),
    }).select("id, so_seri, ngay_dang_ky").single();
    if (error) throw error;

    res.json({ deviceId: data.id, serial: data.so_seri, registeredAt: data.ngay_dang_ky });
  } catch (err) {
    console.error("[POST /admin/devices/register]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/devices/assign/:userId/:deviceId", async (req, res) => {
  try {
    const { userId, deviceId } = req.params;
    const { patientId } = req.body;
    if (!patientId) return res.status(400).json({ error: "Thiếu patientId" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: dev } = await supabase.from("thiet_bi_iot").select("id, co_so_y_te_id").eq("id",deviceId).maybeSingle();
    if (!dev || dev.co_so_y_te_id !== hsId)
      return res.status(403).json({ error: "Thiết bị không thuộc đơn vị của bạn" });

    await supabase.from("lich_su_gan_thiet_bi")
      .update({ trang_thai_hoat_dong: false, ngay_huy_gan: new Date().toISOString() })
      .eq("thiet_bi_id", deviceId).eq("trang_thai_hoat_dong", true);

    const { error } = await supabase.from("lich_su_gan_thiet_bi").insert({
      thiet_bi_id: deviceId, nguoi_dung_tb_id: patientId,
      nguoi_gan: userId, ngay_gan: new Date().toISOString(), trang_thai_hoat_dong: true,
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /admin/devices/assign]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/devices/unassign/:userId/:deviceId", async (req, res) => {
  try {
    const { userId, deviceId } = req.params;
    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: dev } = await supabase.from("thiet_bi_iot").select("id, co_so_y_te_id").eq("id",deviceId).maybeSingle();
    if (!dev || dev.co_so_y_te_id !== hsId)
      return res.status(403).json({ error: "Thiết bị không thuộc đơn vị của bạn" });

    await supabase.from("lich_su_gan_thiet_bi")
      .update({ trang_thai_hoat_dong: false, ngay_huy_gan: new Date().toISOString() })
      .eq("thiet_bi_id", deviceId).eq("trang_thai_hoat_dong", true);

    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /admin/devices/unassign]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/devices/provision/:userId/:deviceId", async (req, res) => {
  try {
    const { userId, deviceId } = req.params;
    const { patientId } = req.body;
    if (!patientId) return res.status(400).json({ error: "Thiếu patientId" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: dev } = await supabase.from("thiet_bi_iot")
      .select("id, co_so_y_te_id, so_seri").eq("id",deviceId).maybeSingle();
    if (!dev || dev.co_so_y_te_id !== hsId)
      return res.status(403).json({ error: "Thiết bị không thuộc đơn vị của bạn" });

    const { data: patient } = await supabase.from("nguoi_dung")
      .select("id, ho_ten").eq("id",patientId).maybeSingle();
    if (!patient) return res.status(404).json({ error: "Không tìm thấy bệnh nhân" });

    await supabase.from("lich_su_gan_thiet_bi")
      .update({ trang_thai_hoat_dong: false, ngay_huy_gan: new Date().toISOString() })
      .eq("thiet_bi_id", deviceId).eq("trang_thai_hoat_dong", true);

    await supabase.from("lich_su_gan_thiet_bi").insert({
      thiet_bi_id: deviceId, nguoi_dung_tb_id: patientId,
      nguoi_gan: userId, ngay_gan: new Date().toISOString(), trang_thai_hoat_dong: true,
    });

    const DOCTOR_API = process.env.DOCTOR_API_URL || "https://health-monitor-system-twts.onrender.com";
    res.json({
      ok: true,
      deviceSerial:  dev.so_seri,
      patientId:     patient.id,
      patientName:   patient.ho_ten,
      apiEndpoint:   DOCTOR_API,
      provisionedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[POST /admin/devices/provision]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BỆNH NHÂN
// ============================================================

app.get("/admin/patients/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: devices } = await supabase.from("thiet_bi_iot").select("id").eq("co_so_y_te_id",hsId);
    const devIds = (devices||[]).map(d=>d.id);
    if (!devIds.length) return res.json([]);

    const { data: assigns } = await supabase.from("lich_su_gan_thiet_bi")
      .select("nguoi_dung_tb_id, thiet_bi_id")
      .in("thiet_bi_id", devIds).eq("trang_thai_hoat_dong", true);

    const ptIds = [...new Set((assigns||[]).map(a=>a.nguoi_dung_tb_id).filter(Boolean))];
    if (!ptIds.length) return res.json([]);

    const { data: pts } = await supabase.from("nguoi_dung")
      .select("id, ho_ten, so_dien_thoai, email, ngay_sinh, gioi_tinh").in("id",ptIds);

    const { data: profiles } = await supabase.from("ho_so_benh_nhan")
      .select("nguoi_dung_tb_id, nhom_mau, benh_man_tinh").in("nguoi_dung_tb_id",ptIds);
    const profMap = {};
    (profiles||[]).forEach(p=>{ profMap[p.nguoi_dung_tb_id]=p; });

    const { data: docLinks } = await supabase.from("lien_ket_bac_si")
      .select("nguoi_dung_tb_id, nguoi_dung_bs_id, nguoi_dung!nguoi_dung_bs_id(ho_ten)")
      .in("nguoi_dung_tb_id",ptIds).eq("trang_thai_hoat_dong",true);
    const docMap = {};
    (docLinks||[]).forEach(l=>{ docMap[l.nguoi_dung_tb_id]={ id:l.nguoi_dung_bs_id, name:l.nguoi_dung?.ho_ten }; });

    const devMap = {};
    (assigns||[]).forEach(a=>{ devMap[a.nguoi_dung_tb_id]=a.thiet_bi_id; });

    res.json((pts||[]).map(p=>({
      id:p.id, name:p.ho_ten, phone:p.so_dien_thoai, email:p.email,
      dob:p.ngay_sinh, gender:p.gioi_tinh,
      bloodType:profMap[p.id]?.nhom_mau,
      disease:profMap[p.id]?.benh_man_tinh,
      deviceId:devMap[p.id]||null,
      doctor:docMap[p.id]||null,
    })));
  } catch (err) {
    console.error("[GET /admin/patients]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/patients/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, phone, email, dob, gender, bloodType, disease, allergy, history, emergencyName, emergencyPhone } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Vui lòng nhập họ tên" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: newUser, error: userErr } = await supabase.from("nguoi_dung").insert({
      ho_ten:name.trim(), so_dien_thoai:phone||null, email:email||null,
      ngay_sinh:dob||null, gioi_tinh:gender||null, trang_thai_hoat_dong:true,
    }).select("id").single();
    if (userErr) throw userErr;

    const { data: role } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_tb").maybeSingle();
    if (role) await supabase.from("phan_quyen_nguoi_dung").insert({ nguoi_dung_id:newUser.id, vai_tro_id:role.id });

    await supabase.from("ho_so_benh_nhan").insert({
      nguoi_dung_tb_id:newUser.id, nhom_mau:bloodType||null,
      benh_man_tinh:disease||null, di_ung:allergy||null, tien_su_y_te:history||null,
      nguoi_lien_he_khan_ten:emergencyName||null, nguoi_lien_he_khan_sdt:emergencyPhone||null,
    });

    res.json({ patientId:newUser.id, name:name.trim() });
  } catch (err) {
    console.error("[POST /admin/patients]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// NGƯỜI NHÀ
// ============================================================

app.post("/admin/families/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { patientId, name, phone, email, relation, isPrimary, password } = req.body;
    if (!patientId || !name?.trim()) return res.status(400).json({ error: "Thiếu thông tin bắt buộc" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: newUser, error: userErr } = await supabase.from("nguoi_dung").insert({
      ho_ten:name.trim(), so_dien_thoai:phone||null, email:email||null,
      mat_khau:password||"123456", trang_thai_hoat_dong:true,
    }).select("id").single();
    if (userErr) throw userErr;

    const { data: role } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_lq").maybeSingle();
    if (role) await supabase.from("phan_quyen_nguoi_dung").insert({ nguoi_dung_id:newUser.id, vai_tro_id:role.id });

    if (isPrimary) {
      await supabase.from("lien_ket_nguoi_nha")
        .update({ la_nguoi_giam_sat_chinh:false })
        .eq("nguoi_dung_tb_id",patientId).eq("trang_thai_hoat_dong",true);
    }

    const { error: linkErr } = await supabase.from("lien_ket_nguoi_nha").insert({
      nguoi_dung_tb_id:patientId, nguoi_dung_lq_id:newUser.id,
      moi_quan_he:relation||null, la_nguoi_giam_sat_chinh:isPrimary||false,
      trang_thai_hoat_dong:true, ngay_lien_ket:new Date().toISOString(),
    });
    if (linkErr) throw linkErr;

    res.json({ familyId:newUser.id, name:name.trim() });
  } catch (err) {
    console.error("[POST /admin/families]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BÁC SĨ
// ============================================================

app.get("/admin/doctors/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: bsRole } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_bs").maybeSingle();
    if (!bsRole) return res.json([]);

    const { data: pq } = await supabase.from("phan_quyen_nguoi_dung").select("nguoi_dung_id").eq("vai_tro_id",bsRole.id);
    const bsIds = (pq||[]).map(p=>p.nguoi_dung_id);
    if (!bsIds.length) return res.json([]);

    const { data: doctors } = await supabase.from("nguoi_dung")
      .select("id, ho_ten, so_dien_thoai, email")
      .in("id",bsIds).eq("co_so_y_te_id",hsId).eq("trang_thai_hoat_dong",true);

    const { data: links } = await supabase.from("lien_ket_bac_si")
      .select("nguoi_dung_bs_id").in("nguoi_dung_bs_id",bsIds).eq("trang_thai_hoat_dong",true);
    const countMap = {};
    (links||[]).forEach(l=>{ countMap[l.nguoi_dung_bs_id]=(countMap[l.nguoi_dung_bs_id]||0)+1; });

    res.json((doctors||[]).map(d=>({
      id:d.id, name:d.ho_ten, phone:d.so_dien_thoai,
      email:d.email, patientCount:countMap[d.id]||0,
    })));
  } catch (err) {
    console.error("[GET /admin/doctors]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/doctors/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, phone, email, password } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Vui lòng nhập họ tên" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    if (email) {
      const { data: existing } = await supabase.from("nguoi_dung").select("id")
        .eq("email", email.trim().toLowerCase()).maybeSingle();
      if (existing) return res.status(409).json({ error: "Email đã tồn tại trong hệ thống" });
    }

    const { data: newUser, error: userErr } = await supabase.from("nguoi_dung").insert({
      ho_ten:name.trim(), so_dien_thoai:phone||null,
      email:email?email.trim().toLowerCase():null,
      mat_khau:password||"123456",
      co_so_y_te_id:hsId, trang_thai_hoat_dong:true,
    }).select("id").single();
    if (userErr) throw userErr;

    const { data: role } = await supabase.from("vai_tro").select("id").eq("ten_vai_tro","user_bs").maybeSingle();
    if (role) await supabase.from("phan_quyen_nguoi_dung").insert({ nguoi_dung_id:newUser.id, vai_tro_id:role.id });

    res.json({ doctorId:newUser.id, name:name.trim() });
  } catch (err) {
    console.error("[POST /admin/doctors]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/assign-doctor/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { patientId, doctorId } = req.body;
    if (!patientId || !doctorId) return res.status(400).json({ error: "Thiếu thông tin" });

    const hsId = await getAdminHospital(userId);
    if (!hsId) return res.status(403).json({ error: "Không có quyền truy cập" });

    const { data: doc } = await supabase.from("nguoi_dung").select("id, co_so_y_te_id").eq("id",doctorId).maybeSingle();
    if (!doc || doc.co_so_y_te_id !== hsId)
      return res.status(403).json({ error: "Bác sĩ không thuộc đơn vị của bạn" });

    await supabase.from("lien_ket_bac_si")
      .update({ trang_thai_hoat_dong:false })
      .eq("nguoi_dung_tb_id",patientId).eq("trang_thai_hoat_dong",true);

    const { error } = await supabase.from("lien_ket_bac_si").insert({
      nguoi_dung_tb_id:patientId, nguoi_dung_bs_id:doctorId,
      trang_thai_hoat_dong:true, ngay_phan_cong:new Date().toISOString(),
    });
    if (error) throw error;

    res.json({ ok:true });
  } catch (err) {
    console.error("[POST /admin/assign-doctor]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🏥 HealthMonitor Admin API v1.0 — port ${PORT}`);
  console.log("Routes:");
  console.log("  POST /admin/auth/login");
  console.log("  POST /admin/auth/change-password");
  console.log("  GET  /admin/hospitals");
  console.log("  GET  /admin/overview/:userId");
  console.log("  GET  /admin/devices/:userId");
  console.log("  POST /admin/devices/register/:userId");
  console.log("  POST /admin/devices/assign/:userId/:deviceId");
  console.log("  POST /admin/devices/unassign/:userId/:deviceId");
  console.log("  POST /admin/devices/provision/:userId/:deviceId");
  console.log("  GET  /admin/patients/:userId");
  console.log("  POST /admin/patients/:userId");
  console.log("  POST /admin/families/:userId");
  console.log("  GET  /admin/doctors/:userId");
  console.log("  POST /admin/doctors/:userId");
  console.log("  POST /admin/assign-doctor/:userId");
});
