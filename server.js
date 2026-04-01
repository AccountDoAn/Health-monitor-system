const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== CORS =====
app.use(
  cors({
    origin: ["https://accountdoan.github.io"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  }),
);
app.use(express.json());
//==============================

// ===== Supabase ==========
const supabase = createClient(
  "https://czgberdpnfultxkljhko.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6Z2JlcmRwbmZ1bHR4a2xqaGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3OTY3MTEsImV4cCI6MjA5MDM3MjcxMX0.H9pv62PGbIJqJNK72yGEGB1Y9yw7HPEvk82zdxlgVYg",
);
//==========================
app.get("/", (req, res) => {
  res.json({ status: "ok", version: "3.3" });
});

// ============================================================
// MODULE 1: DỮ LIỆU SINH TỒN
// ============================================================

// GET /vitals — 50 bản ghi mới nhất, join tên bệnh nhân + cảnh báo
app.get("/vitals", async (req, res) => {
  try {
    console.log("\n" + "=".repeat(70));
    console.log("📡 [GET /vitals] Request at", new Date().toISOString());
    console.log("=".repeat(70));

    // 1. Lấy sinh tồn, join trực tiếp tên bệnh nhân qua FK
    console.log("\n📤 [Step 1] Fetching raw vitals from Supabase...");
    const { data: vitals, error: vitalsError } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id,
        thiet_bi_id,
        nguoi_dung_tb_id,
        nhip_tim,
        spo2,
        che_do_lay_mau,
        delta_nhip_tim,
        delta_spo2,
        luu_tru_cuc_bo,
        thoi_gian_do,
        nguoi_dung!nguoi_dung_tb_id ( ho_ten )
      `,
      )
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (vitalsError) throw vitalsError;

    console.log(
      `✅ Fetched ${vitals.length} vital records from du_lieu_sinh_ton`,
    );
    console.log("📋 [Raw Vitals - First 5 Records]:");
    vitals.slice(0, 5).forEach((v, i) => {
      console.log(
        `   ${i + 1}. ID:${v.id} | User:${v.nguoi_dung_tb_id} | Device:${v.thiet_bi_id} | Name:${v.nguoi_dung?.ho_ten || "NULL"} | Time:${v.thoi_gian_do} | HR:${v.nhip_tim}`,
      );
    });

    // 2. Lấy cảnh báo liên quan đến các bản ghi sinh tồn trên
    console.log("\n📤 [Step 2] Fetching alerts...");
    const vitalIds = vitals.map((v) => v.id);
    let alertMap = {};

    if (vitalIds.length > 0) {
      const { data: alerts } = await supabase
        .from("canh_bao_suc_khoe")
        .select(
          "du_lieu_sinh_ton_id, loai_canh_bao, muc_do_nghiem_trong, trang_thai_xu_ly",
        )
        .in("du_lieu_sinh_ton_id", vitalIds);

      (alerts || []).forEach((a) => {
        alertMap[a.du_lieu_sinh_ton_id] = {
          alertType: a.loai_canh_bao,
          severity: a.muc_do_nghiem_trong,
          status: a.trang_thai_xu_ly,
        };
      });
      console.log(`✅ Fetched ${alerts?.length || 0} alerts`);
    }

    // 3. Format response
    console.log("\n📝 [Step 3] Formatting result...");
    const result = vitals.map((v) => ({
      id: v.id,
      deviceId: v.thiet_bi_id,
      patientId: v.nguoi_dung_tb_id,
      patientName: v.nguoi_dung?.ho_ten || "Unknown",
      heartRate: v.nhip_tim,
      spo2: v.spo2,
      samplingMode: v.che_do_lay_mau,
      deltaHeartRate: v.delta_nhip_tim,
      deltaSpo2: v.delta_spo2,
      isCached: v.luu_tru_cuc_bo,
      time: v.thoi_gian_do,
      alertType: alertMap[v.id]?.alertType || null,
      alertLevel: alertMap[v.id]?.severity || "binh_thuong",
      alertStatus: alertMap[v.id]?.status || null,
    }));

    const uniquePatients = [...new Set(result.map((r) => r.patientName))];
    console.log("📊 [Final Result]:");
    console.log(`   Total: ${result.length} records`);
    console.log(`   Patients: [${uniquePatients.join(", ")}]`);
    console.log(
      `   Dates: ${result[result.length - 1]?.time} → ${result[0]?.time}`,
    );
    console.log("\n✅ Returning result");
    console.log("=".repeat(70) + "\n");

    res.json(result);
  } catch (err) {
    console.error("\n❌ [GET /vitals] ERROR:", err.message);
    console.log("=".repeat(70) + "\n");
    res.status(500).json({ error: err.message });
  }
});

// 🔍 DEBUG ENDPOINT
app.get("/debug/vitals-raw", async (req, res) => {
  try {
    console.log("\n🔍 [/debug/vitals-raw] QA Debug Endpoint\n");

    const { data: vitals, error: vitalsErr } = await supabase
      .from("du_lieu_sinh_ton")
      .select("*")
      .order("thoi_gian_do", { ascending: false })
      .limit(100);

    const { data: users, error: usersErr } = await supabase
      .from("nguoi_dung")
      .select("id, ho_ten, co_so_y_te_id");

    const { data: devices, error: devicesErr } = await supabase
      .from("thiet_bi_iot")
      .select("id, so_seri, co_so_y_te_id");

    if (vitalsErr || usersErr || devicesErr) throw new Error("Query error");

    console.log(
      `📊 Database State: ${vitals?.length || 0} vitals, ${users?.length || 0} users, ${devices?.length || 0} devices`,
    );

    res.json({
      database_state: "RAW DATABASE DUMP",
      vitals_count: vitals?.length || 0,
      users_count: users?.length || 0,
      devices_count: devices?.length || 0,
      recent_vitals: vitals?.slice(0, 20) || [],
      all_users: users || [],
      all_devices: devices || [],
    });
  } catch (err) {
    console.error("❌ Debug error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /vitals/:patientId — sinh tồn theo bệnh nhân
app.get("/vitals/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const { data, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id, thiet_bi_id, nguoi_dung_tb_id,
        nhip_tim, spo2, che_do_lay_mau,
        delta_nhip_tim, delta_spo2, thoi_gian_do
      `,
      )
      .eq("nguoi_dung_tb_id", patientId)
      .order("thoi_gian_do", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[GET /vitals/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 2: CẢNH BÁO
// ============================================================

// GET /alerts — 50 cảnh báo mới nhất, join tên bệnh nhân + chỉ số lúc xảy ra
app.get("/alerts", async (req, res) => {
  try {
    const { data: alerts, error } = await supabase
      .from("canh_bao_suc_khoe")
      .select(
        `
        id,
        du_lieu_sinh_ton_id,
        nguoi_dung_tb_id,
        loai_canh_bao,
        muc_do_nghiem_trong,
        trang_thai_xu_ly,
        thoi_gian_phat_hien,
        thoi_gian_bat_dau_dem_nguoc,
        thoi_gian_leo_thang,
        thoi_gian_xu_ly,
        nguoi_dung!nguoi_dung_tb_id ( ho_ten ),
        du_lieu_sinh_ton!du_lieu_sinh_ton_id (
          thiet_bi_id, nhip_tim, spo2
        )
      `,
      )
      .order("thoi_gian_phat_hien", { ascending: false })
      .limit(50);

    if (error) throw error;

    const result = alerts.map((a) => ({
      alertId: a.id,
      patientId: a.nguoi_dung_tb_id,
      patientName: a.nguoi_dung?.ho_ten || "Unknown",
      deviceId: a.du_lieu_sinh_ton?.thiet_bi_id || null,
      heartRate: a.du_lieu_sinh_ton?.nhip_tim || null,
      spo2: a.du_lieu_sinh_ton?.spo2 || null,
      alertType: a.loai_canh_bao,
      severity: a.muc_do_nghiem_trong,
      status: a.trang_thai_xu_ly,
      detectedAt: a.thoi_gian_phat_hien,
      countdownAt: a.thoi_gian_bat_dau_dem_nguoc,
      escalatedAt: a.thoi_gian_leo_thang,
      handledAt: a.thoi_gian_xu_ly,
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /alerts]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /alerts/:patientId — cảnh báo theo bệnh nhân
app.get("/alerts/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;

    const { data, error } = await supabase
      .from("canh_bao_suc_khoe")
      .select(
        `
        id, loai_canh_bao, muc_do_nghiem_trong,
        trang_thai_xu_ly, thoi_gian_phat_hien, thoi_gian_xu_ly,
        du_lieu_sinh_ton!du_lieu_sinh_ton_id ( nhip_tim, spo2 )
      `,
      )
      .eq("nguoi_dung_tb_id", patientId)
      .order("thoi_gian_phat_hien", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[GET /alerts/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 3: BÁC SĨ
// ============================================================

// GET /doctor/:doctorId — thông tin bác sĩ + cơ sở y tế
app.get("/doctor/:doctorId", async (req, res) => {
  try {
    const { doctorId } = req.params;

    const { data, error } = await supabase
      .from("nguoi_dung")
      .select(
        `
        id, ho_ten, email, so_dien_thoai, anh_dai_dien_url,
        co_so_y_te_id,
        co_so_y_te!co_so_y_te_id (
          id, ten_co_so, dia_chi, so_dien_thoai, loai_hinh
        )
      `,
      )
      .eq("id", doctorId)
      .single();

    if (error) throw error;

    res.json({
      doctorId: data.id,
      name: data.ho_ten,
      email: data.email,
      phone: data.so_dien_thoai,
      avatar: data.anh_dai_dien_url,
      hospital: {
        id: data.co_so_y_te?.id,
        name: data.co_so_y_te?.ten_co_so,
        address: data.co_so_y_te?.dia_chi,
        phone: data.co_so_y_te?.so_dien_thoai,
        type: data.co_so_y_te?.loai_hinh,
      },
    });
  } catch (err) {
    console.error("[GET /doctor/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /doctor/:doctorId/patients — danh sách bệnh nhân của bác sĩ
// kèm thiết bị đang dùng + live data
app.get("/doctor/:doctorId/patients", async (req, res) => {
  try {
    const { doctorId } = req.params;

    // 1. Lấy danh sách liên kết bác sĩ - bệnh nhân
    const { data: links, error: linkErr } = await supabase
      .from("lien_ket_bac_si")
      .select(
        `
        nguoi_dung_tb_id,
        tan_suat_theo_doi,
        ngay_phan_cong,
        nguoi_dung!nguoi_dung_tb_id (
          id, ho_ten, so_dien_thoai, email
        )
      `,
      )
      .eq("nguoi_dung_bs_id", doctorId)
      .eq("trang_thai_hoat_dong", true);

    if (linkErr) throw linkErr;

    const patientIds = links.map((l) => l.nguoi_dung_tb_id);
    if (patientIds.length === 0) return res.json([]);

    // 2. Lấy thiết bị đang gán cho từng bệnh nhân
    const { data: assignments } = await supabase
      .from("lich_su_gan_thiet_bi")
      .select(
        `
        nguoi_dung_tb_id,
        thiet_bi_id,
        ngay_gan,
        thiet_bi_iot!thiet_bi_id (
          so_seri, phan_tram_pin, lan_online_cuoi, trang_thai_hoat_dong
        )
      `,
      )
      .eq("trang_thai_hoat_dong", true)
      .in("nguoi_dung_tb_id", patientIds);

    const deviceMap = {};
    (assignments || []).forEach((a) => {
      deviceMap[a.nguoi_dung_tb_id] = {
        deviceId: a.thiet_bi_id,
        serial: a.thiet_bi_iot?.so_seri,
        battery: a.thiet_bi_iot?.phan_tram_pin,
        lastOnline: a.thiet_bi_iot?.lan_online_cuoi,
        active: a.thiet_bi_iot?.trang_thai_hoat_dong,
        assignedAt: a.ngay_gan,
      };
    });

    // 3. Lấy live data của từng bệnh nhân
    const { data: liveData } = await supabase
      .from("trang_thai_live")
      .select(
        "nguoi_dung_tb_id, nhip_tim_live, spo2_live, muc_do_canh_bao, trang_thai_thiet_bi, thoi_gian_cap_nhat",
      )
      .in("nguoi_dung_tb_id", patientIds);

    const liveMap = {};
    (liveData || []).forEach((l) => {
      liveMap[l.nguoi_dung_tb_id] = l;
    });

    // 4. Merge
    const result = links.map((l) => {
      const live = liveMap[l.nguoi_dung_tb_id];
      return {
        patientId: l.nguoi_dung_tb_id,
        patientName: l.nguoi_dung?.ho_ten || "Unknown",
        phone: l.nguoi_dung?.so_dien_thoai,
        email: l.nguoi_dung?.email,
        monitoringLevel: l.tan_suat_theo_doi,
        assignedAt: l.ngay_phan_cong,
        device: deviceMap[l.nguoi_dung_tb_id] || null,
        live: live
          ? {
              heartRate: live.nhip_tim_live,
              spo2: live.spo2_live,
              alertLevel: live.muc_do_canh_bao,
              deviceStatus: live.trang_thai_thiet_bi,
              updatedAt: live.thoi_gian_cap_nhat,
            }
          : null,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("[GET /doctor/:id/patients]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /doctor/:doctorId/families — người nhà của các bệnh nhân thuộc bác sĩ
app.get("/doctor/:doctorId/families", async (req, res) => {
  try {
    const { doctorId } = req.params;

    // Lấy bệnh nhân của bác sĩ
    const { data: links } = await supabase
      .from("lien_ket_bac_si")
      .select("nguoi_dung_tb_id")
      .eq("nguoi_dung_bs_id", doctorId)
      .eq("trang_thai_hoat_dong", true);

    const patientIds = (links || []).map((l) => l.nguoi_dung_tb_id);
    if (patientIds.length === 0) return res.json({});

    // Lấy liên kết người nhà, join tên
    const { data: families, error } = await supabase
      .from("lien_ket_nguoi_nha")
      .select(
        `
        nguoi_dung_tb_id,
        nguoi_dung_lq_id,
        moi_quan_he,
        la_nguoi_giam_sat_chinh,
        ngay_lien_ket,
        nguoi_dung!nguoi_dung_lq_id ( ho_ten, so_dien_thoai, email )
      `,
      )
      .in("nguoi_dung_tb_id", patientIds)
      .eq("trang_thai_hoat_dong", true);

    if (error) throw error;

    // Group theo bệnh nhân
    const result = {};
    (families || []).forEach((f) => {
      if (!result[f.nguoi_dung_tb_id]) result[f.nguoi_dung_tb_id] = [];
      result[f.nguoi_dung_tb_id].push({
        familyId: f.nguoi_dung_lq_id,
        name: f.nguoi_dung?.ho_ten,
        phone: f.nguoi_dung?.so_dien_thoai,
        email: f.nguoi_dung?.email,
        relation: f.moi_quan_he,
        isPrimary: f.la_nguoi_giam_sat_chinh,
        linkedAt: f.ngay_lien_ket,
      });
    });

    res.json(result);
  } catch (err) {
    console.error("[GET /doctor/:id/families]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 4: THIẾT BỊ
// ============================================================

// GET /devices — tất cả thiết bị thuộc cơ sở y tế
app.get("/devices", async (req, res) => {
  try {
    const { csytId } = req.query; // lọc theo cơ sở y tế nếu có

    let query = supabase
      .from("thiet_bi_iot")
      .select(
        `
        id, so_seri, phien_ban_firmware, phien_ban_phan_cung,
        phan_tram_pin, trang_thai_hoat_dong, lan_online_cuoi, ngay_dang_ky,
        co_so_y_te_id,
        co_so_y_te!co_so_y_te_id ( ten_co_so )
      `,
      )
      .order("lan_online_cuoi", { ascending: false });

    if (csytId) query = query.eq("co_so_y_te_id", csytId);

    const { data, error } = await query;
    if (error) throw error;

    // Kiểm tra online: online_cuoi < 60s trước = online
    const now = Date.now();
    const result = data.map((d) => ({
      deviceId: d.id,
      serial: d.so_seri,
      firmware: d.phien_ban_firmware,
      hardware: d.phien_ban_phan_cung,
      battery: d.phan_tram_pin,
      active: d.trang_thai_hoat_dong,
      online: d.lan_online_cuoi
        ? now - new Date(d.lan_online_cuoi).getTime() < 60000
        : false,
      lastOnline: d.lan_online_cuoi,
      registeredAt: d.ngay_dang_ky,
      hospitalId: d.co_so_y_te_id,
      hospitalName: d.co_so_y_te?.ten_co_so,
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /devices]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/active — thiết bị đang được gán cho bệnh nhân
app.get("/devices/active", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("lich_su_gan_thiet_bi")
      .select(
        `
        thiet_bi_id,
        nguoi_dung_tb_id,
        ngay_gan,
        thiet_bi_iot!thiet_bi_id (
          so_seri, phan_tram_pin, lan_online_cuoi,
          trang_thai_hoat_dong,
          co_so_y_te_id,
          co_so_y_te!co_so_y_te_id ( ten_co_so )
        ),
        nguoi_dung!nguoi_dung_tb_id ( ho_ten, so_dien_thoai )
      `,
      )
      .eq("trang_thai_hoat_dong", true);

    if (error) throw error;

    const now = Date.now();
    const result = data.map((d) => ({
      deviceId: d.thiet_bi_id,
      serial: d.thiet_bi_iot?.so_seri,
      battery: d.thiet_bi_iot?.phan_tram_pin,
      online: d.thiet_bi_iot?.lan_online_cuoi
        ? now - new Date(d.thiet_bi_iot.lan_online_cuoi).getTime() < 60000
        : false,
      lastOnline: d.thiet_bi_iot?.lan_online_cuoi,
      hospitalId: d.thiet_bi_iot?.co_so_y_te_id,
      hospitalName: d.thiet_bi_iot?.co_so_y_te?.ten_co_so,
      patientId: d.nguoi_dung_tb_id,
      patientName: d.nguoi_dung?.ho_ten,
      patientPhone: d.nguoi_dung?.so_dien_thoai,
      assignedAt: d.ngay_gan,
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /devices/active]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:deviceId/status — trạng thái 1 thiết bị
app.get("/devices/:deviceId/status", async (req, res) => {
  try {
    const { deviceId } = req.params;

    const { data, error } = await supabase
      .from("thiet_bi_iot")
      .select(
        `
        id, so_seri, phien_ban_firmware, phan_tram_pin,
        trang_thai_hoat_dong, lan_online_cuoi,
        co_so_y_te!co_so_y_te_id ( ten_co_so )
      `,
      )
      .eq("id", deviceId)
      .single();

    if (error) throw error;

    const now = Date.now();
    const online = data.lan_online_cuoi
      ? now - new Date(data.lan_online_cuoi).getTime() < 60000
      : false;

    res.json({
      deviceId: data.id,
      serial: data.so_seri,
      firmware: data.phien_ban_firmware,
      battery: data.phan_tram_pin,
      active: data.trang_thai_hoat_dong,
      online,
      lastOnline: data.lan_online_cuoi,
      hospital: data.co_so_y_te?.ten_co_so,
    });
  } catch (err) {
    console.error("[GET /devices/:id/status]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/assign — gán thiết bị cho bệnh nhân
app.post("/devices/assign", async (req, res) => {
  try {
    const { deviceId, patientId, assignedBy } = req.body;
    if (!deviceId || !patientId) {
      return res
        .status(400)
        .json({ error: "deviceId và patientId là bắt buộc" });
    }

    // Hủy gán cũ nếu có
    await supabase
      .from("lich_su_gan_thiet_bi")
      .update({ trang_thai_hoat_dong: false, ngay_huy_gan: new Date() })
      .eq("thiet_bi_id", deviceId)
      .eq("trang_thai_hoat_dong", true);

    // Gán mới
    const { data, error } = await supabase
      .from("lich_su_gan_thiet_bi")
      .insert({
        thiet_bi_id: deviceId,
        nguoi_dung_tb_id: patientId,
        nguoi_gan: assignedBy || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "Gán thiết bị thành công", data });
  } catch (err) {
    console.error("[POST /devices/assign]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/unassign — hủy gán thiết bị
app.post("/devices/unassign", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId)
      return res.status(400).json({ error: "deviceId là bắt buộc" });

    const { error } = await supabase
      .from("lich_su_gan_thiet_bi")
      .update({ trang_thai_hoat_dong: false, ngay_huy_gan: new Date() })
      .eq("thiet_bi_id", deviceId)
      .eq("trang_thai_hoat_dong", true);

    if (error) throw error;
    res.json({ message: "Hủy gán thiết bị thành công" });
  } catch (err) {
    console.error("[POST /devices/unassign]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 5: CƠ SỞ Y TẾ
// ============================================================

// GET /hospitals — danh sách cơ sở y tế
app.get("/hospitals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("co_so_y_te")
      .select(
        "id, ten_co_so, dia_chi, so_dien_thoai, email_lien_he, loai_hinh, trang_thai_hoat_dong, ngay_tao",
      )
      .eq("trang_thai_hoat_dong", true)
      .order("ten_co_so");

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[GET /hospitals]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /hospitals/:hospitalId/summary — tổng quan 1 cơ sở y tế
app.get("/hospitals/:hospitalId/summary", async (req, res) => {
  try {
    const { hospitalId } = req.params;

    const [csyt, devices, doctors, patients] = await Promise.all([
      supabase.from("co_so_y_te").select("*").eq("id", hospitalId).single(),
      supabase
        .from("thiet_bi_iot")
        .select("id, trang_thai_hoat_dong")
        .eq("co_so_y_te_id", hospitalId),
      supabase.from("nguoi_dung").select("id").eq("co_so_y_te_id", hospitalId),
      supabase
        .from("lich_su_gan_thiet_bi")
        .select("nguoi_dung_tb_id")
        .eq("trang_thai_hoat_dong", true),
    ]);

    if (csyt.error) throw csyt.error;

    res.json({
      hospital: csyt.data,
      totalDevices: devices.data?.length || 0,
      activeDevices:
        devices.data?.filter((d) => d.trang_thai_hoat_dong).length || 0,
      totalStaff: doctors.data?.length || 0,
      activePatients: patients.data?.length || 0,
    });
  } catch (err) {
    console.error("[GET /hospitals/:id/summary]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 6: LIVE DATA
// ============================================================

// GET /live/:patientId — dữ liệu real-time của 1 bệnh nhân
app.get("/live/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;

    const { data, error } = await supabase
      .from("trang_thai_live")
      .select("*")
      .eq("nguoi_dung_tb_id", patientId)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[GET /live/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Health Monitor API v3.3 running on port ${PORT}`);
  console.log("Routes:");
  console.log("  GET  /vitals");
  console.log("  GET  /vitals/:patientId");
  console.log("  GET  /alerts");
  console.log("  GET  /alerts/:patientId");
  console.log("  GET  /doctor/:doctorId");
  console.log("  GET  /doctor/:doctorId/patients");
  console.log("  GET  /doctor/:doctorId/families");
  console.log("  GET  /devices");
  console.log("  GET  /devices/active");
  console.log("  GET  /devices/:deviceId/status");
  console.log("  POST /devices/assign");
  console.log("  POST /devices/unassign");
  console.log("  GET  /hospitals");
  console.log("  GET  /hospitals/:hospitalId/summary");
  console.log("  GET  /live/:patientId");
});
