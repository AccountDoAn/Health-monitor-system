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

// ===== Supabase (service_role để bypass RLS) =====
const supabase = createClient(
  "https://czgberdpnfultxkljhko.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6Z2JlcmRwbmZ1bHR4a2xqaGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3OTY3MTEsImV4cCI6MjA5MDM3MjcxMX0.H9pv62PGbIJqJNK72yGEGB1Y9yw7HPEvk82zdxlgVYg",
);

// ===== Health check =====
app.get("/", (req, res) => {
  res.json({ status: "ok", version: "3.3" });
});

// ============================================================
// MODULE 1: DỮ LIỆU SINH TỒN
// ============================================================

// GET /vitals — bản ghi mới nhất của mỗi bệnh nhân
app.get("/vitals", async (req, res) => {
  try {
    // 1. Lấy ID bản ghi mới nhất của từng bệnh nhân
    // Dùng raw SQL qua Supabase RPC hoặc lấy toàn bộ rồi lọc phía server
    // Cách an toàn: lấy 500 bản ghi mới nhất rồi deduplicate theo patientId
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
        thoi_gian_do
      `,
      )
      .order("thoi_gian_do", { ascending: false })
      .limit(500); // lấy nhiều để đảm bảo có đủ bệnh nhân

    if (vitalsError) throw vitalsError;
    if (!vitals || vitals.length === 0) return res.json([]);

    // 2. Deduplicate — chỉ giữ bản ghi mới nhất của mỗi bệnh nhân
    const latestPerPatient = {};
    vitals.forEach((v) => {
      if (!latestPerPatient[v.nguoi_dung_tb_id]) {
        latestPerPatient[v.nguoi_dung_tb_id] = v;
      }
    });
    const uniqueVitals = Object.values(latestPerPatient);

    // 3. Lấy tên bệnh nhân
    const uniquePatientIds = uniqueVitals
      .map((v) => v.nguoi_dung_tb_id)
      .filter(Boolean);

    const userMap = {};
    if (uniquePatientIds.length > 0) {
      const { data: users } = await supabase
        .from("nguoi_dung")
        .select("id, ho_ten")
        .in("id", uniquePatientIds)
        .limit(uniquePatientIds.length);

      (users || []).forEach((u) => {
        if (uniquePatientIds.includes(u.id)) userMap[u.id] = u.ho_ten;
      });
    }

    // 4. Lấy cảnh báo liên quan
    const vitalIds = uniqueVitals.map((v) => v.id).filter(Boolean);
    const alertMap = {};
    if (vitalIds.length > 0) {
      const { data: alerts } = await supabase
        .from("canh_bao_suc_khoe")
        .select(
          "du_lieu_sinh_ton_id, loai_canh_bao, muc_do_nghiem_trong, trang_thai_xu_ly",
        )
        .in("du_lieu_sinh_ton_id", vitalIds)
        .limit(vitalIds.length);

      (alerts || []).forEach((a) => {
        alertMap[a.du_lieu_sinh_ton_id] = {
          alertType: a.loai_canh_bao,
          severity: a.muc_do_nghiem_trong,
          status: a.trang_thai_xu_ly,
        };
      });
    }

    // 5. Format response
    const result = uniqueVitals.map((v) => ({
      id: v.id,
      deviceId: v.thiet_bi_id,
      patientId: v.nguoi_dung_tb_id,
      patientName:
        userMap[v.nguoi_dung_tb_id] || `ID:${v.nguoi_dung_tb_id?.slice(0, 8)}`,
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

    res.json(result);
  } catch (err) {
    console.error("[GET /vitals]", err.message);
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

// GET /vitals/all-dates — danh sách các ngày có dữ liệu sinh tồn (YYYY-MM-DD)
app.get("/vitals/all-dates", async (req, res) => {
  try {
    // Lấy toàn bộ thoi_gian_do, deduplicate theo ngày phía server
    const { data, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select("thoi_gian_do")
      .order("thoi_gian_do", { ascending: false })
      .limit(5000);

    if (error) throw error;

    // Convert sang ngày UTC+7 và deduplicate
    const dateSet = new Set();
    (data || []).forEach((r) => {
      if (!r.thoi_gian_do) return;
      const d = new Date(r.thoi_gian_do);
      // UTC+7
      const localDate = new Date(d.getTime() + 7 * 60 * 60 * 1000);
      const key = localDate.toISOString().slice(0, 10);
      dateSet.add(key);
    });

    res.json([...dateSet].sort((a, b) => b.localeCompare(a)));
  } catch (err) {
    console.error("[GET /vitals/all-dates]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /vitals/date/:date — tất cả dữ liệu sinh tồn của 1 ngày cụ thể (YYYY-MM-DD)
// Trả về toàn bộ bản ghi của mọi bệnh nhân trong ngày đó
app.get("/vitals/date/:date", async (req, res) => {
  try {
    const { date } = req.params; // VD: 2026-03-31

    // Tính khoảng thời gian của ngày đó theo UTC+7
    const startUTC = new Date(`${date}T00:00:00+07:00`).toISOString();
    const endUTC = new Date(`${date}T23:59:59+07:00`).toISOString();

    const { data: vitals, error: vitalsError } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id, thiet_bi_id, nguoi_dung_tb_id,
        nhip_tim, spo2, che_do_lay_mau,
        delta_nhip_tim, delta_spo2, luu_tru_cuc_bo, thoi_gian_do
      `,
      )
      .gte("thoi_gian_do", startUTC)
      .lte("thoi_gian_do", endUTC)
      .order("thoi_gian_do", { ascending: false })
      .limit(1000);

    if (vitalsError) throw vitalsError;
    if (!vitals || vitals.length === 0) return res.json([]);

    // Lấy tên bệnh nhân
    const uniquePatientIds = [
      ...new Set(vitals.map((v) => v.nguoi_dung_tb_id).filter(Boolean)),
    ];
    const userMap = {};
    if (uniquePatientIds.length > 0) {
      const { data: users } = await supabase
        .from("nguoi_dung")
        .select("id, ho_ten")
        .in("id", uniquePatientIds)
        .limit(uniquePatientIds.length);
      (users || []).forEach((u) => {
        if (uniquePatientIds.includes(u.id)) userMap[u.id] = u.ho_ten;
      });
    }

    const result = vitals.map((v) => ({
      id: v.id,
      deviceId: v.thiet_bi_id,
      patientId: v.nguoi_dung_tb_id,
      patientName:
        userMap[v.nguoi_dung_tb_id] || `ID:${v.nguoi_dung_tb_id?.slice(0, 8)}`,
      heartRate: v.nhip_tim,
      spo2: v.spo2,
      samplingMode: v.che_do_lay_mau,
      deltaHeartRate: v.delta_nhip_tim,
      deltaSpo2: v.delta_spo2,
      isCached: v.luu_tru_cuc_bo,
      time: v.thoi_gian_do,
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /vitals/date/:date]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 2: CẢNH BÁO
// ============================================================

// GET /alerts — 50 cảnh báo mới nhất, join tên bệnh nhân + chỉ số lúc xảy ra
app.get("/alerts", async (req, res) => {
  try {
    // 1. Lấy cảnh báo — không dùng FK join
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
        thoi_gian_xu_ly
      `,
      )
      .order("thoi_gian_phat_hien", { ascending: false })
      .limit(50);

    if (error) throw error;
    if (!alerts || alerts.length === 0) return res.json([]);

    // 2. Lấy tên bệnh nhân — chỉ đúng các UUID có trong alerts
    const uniquePatientIds = [
      ...new Set(alerts.map((a) => a.nguoi_dung_tb_id).filter(Boolean)),
    ];
    const userMap = {};
    if (uniquePatientIds.length > 0) {
      const { data: users } = await supabase
        .from("nguoi_dung")
        .select("id, ho_ten")
        .in("id", uniquePatientIds)
        .limit(uniquePatientIds.length);
      (users || []).forEach((u) => {
        if (uniquePatientIds.includes(u.id)) userMap[u.id] = u.ho_ten;
      });
    }

    // 3. Lấy chỉ số sinh tồn lúc xảy ra cảnh báo
    const vitalIds = [
      ...new Set(alerts.map((a) => a.du_lieu_sinh_ton_id).filter(Boolean)),
    ];
    const vitalMap = {};
    if (vitalIds.length > 0) {
      const { data: vitals } = await supabase
        .from("du_lieu_sinh_ton")
        .select("id, thiet_bi_id, nhip_tim, spo2")
        .in("id", vitalIds)
        .limit(vitalIds.length);
      (vitals || []).forEach((v) => {
        if (vitalIds.includes(v.id)) vitalMap[v.id] = v;
      });
    }

    // 4. Format
    const result = alerts.map((a) => ({
      alertId: a.id,
      patientId: a.nguoi_dung_tb_id,
      patientName:
        userMap[a.nguoi_dung_tb_id] || `ID:${a.nguoi_dung_tb_id?.slice(0, 8)}`,
      deviceId: vitalMap[a.du_lieu_sinh_ton_id]?.thiet_bi_id || null,
      heartRate: vitalMap[a.du_lieu_sinh_ton_id]?.nhip_tim || null,
      spo2: vitalMap[a.du_lieu_sinh_ton_id]?.spo2 || null,
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

// GET /doctor/:doctorId — thông tin bác sĩ + cơ sở y tế + vai trò
app.get("/doctor/:doctorId", async (req, res) => {
  try {
    const { doctorId } = req.params;

    // Dùng .maybeSingle() thay .single() để không throw khi không tìm thấy
    const { data: doctor, error: docErr } = await supabase
      .from("nguoi_dung")
      .select(
        "id, ho_ten, email, so_dien_thoai, anh_dai_dien_url, co_so_y_te_id",
      )
      .eq("id", doctorId)
      .maybeSingle();

    if (docErr) throw docErr;
    if (!doctor) {
      return res.status(404).json({
        error: `Không tìm thấy người dùng với ID: ${doctorId}`,
        hint: "Kiểm tra lại DOCTOR_ID trong frontend hoặc chạy query: SELECT id, ho_ten FROM nguoi_dung JOIN phan_quyen_nguoi_dung pq ON pq.nguoi_dung_id = nguoi_dung.id JOIN vai_tro vt ON vt.id = pq.vai_tro_id WHERE vt.ten_vai_tro = 'user_bs'",
      });
    }

    // Lấy vai trò của bác sĩ
    const { data: pq } = await supabase
      .from("phan_quyen_nguoi_dung")
      .select("vai_tro_id, vai_tro(ten_vai_tro)")
      .eq("nguoi_dung_id", doctorId);

    const roles = (pq || []).map((p) => p.vai_tro?.ten_vai_tro).filter(Boolean);

    // Lấy thông tin cơ sở y tế
    let hospital = null;
    if (doctor.co_so_y_te_id) {
      const { data: csyt } = await supabase
        .from("co_so_y_te")
        .select("id, ten_co_so, dia_chi, so_dien_thoai, loai_hinh")
        .eq("id", doctor.co_so_y_te_id)
        .maybeSingle();
      hospital = csyt;
    }

    res.json({
      doctorId: doctor.id,
      name: doctor.ho_ten,
      email: doctor.email,
      phone: doctor.so_dien_thoai,
      avatar: doctor.anh_dai_dien_url,
      roles,
      hospital: hospital
        ? {
            id: hospital.id,
            name: hospital.ten_co_so,
            address: hospital.dia_chi,
            phone: hospital.so_dien_thoai,
            type: hospital.loai_hinh,
          }
        : null,
    });
  } catch (err) {
    console.error("[GET /doctor/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /doctor/:doctorId/patients — danh sách bệnh nhân của bác sĩ
app.get("/doctor/:doctorId/patients", async (req, res) => {
  try {
    const { doctorId } = req.params;

    // 1. Lấy danh sách liên kết
    const { data: links, error: linkErr } = await supabase
      .from("lien_ket_bac_si")
      .select("nguoi_dung_tb_id, tan_suat_theo_doi, ngay_phan_cong")
      .eq("nguoi_dung_bs_id", doctorId)
      .eq("trang_thai_hoat_dong", true);

    if (linkErr) throw linkErr;
    if (!links || links.length === 0) return res.json([]);

    const patientIds = links.map((l) => l.nguoi_dung_tb_id).filter(Boolean);

    // 2. Lấy thông tin bệnh nhân
    const { data: patients } = await supabase
      .from("nguoi_dung")
      .select("id, ho_ten, so_dien_thoai, email")
      .in("id", patientIds)
      .limit(patientIds.length);

    const patientMap = {};
    (patients || []).forEach((p) => {
      if (patientIds.includes(p.id)) patientMap[p.id] = p;
    });

    // 3. Lấy thiết bị đang gán
    const { data: assignments } = await supabase
      .from("lich_su_gan_thiet_bi")
      .select("thiet_bi_id, nguoi_dung_tb_id, ngay_gan")
      .eq("trang_thai_hoat_dong", true)
      .in("nguoi_dung_tb_id", patientIds)
      .limit(patientIds.length);

    const assignMap = {};
    (assignments || []).forEach((a) => {
      if (patientIds.includes(a.nguoi_dung_tb_id))
        assignMap[a.nguoi_dung_tb_id] = a;
    });

    // 4. Lấy thông tin thiết bị
    const deviceIds = [
      ...new Set(
        Object.values(assignMap)
          .map((a) => a.thiet_bi_id)
          .filter(Boolean),
      ),
    ];
    const deviceMap = {};
    if (deviceIds.length > 0) {
      const { data: devices } = await supabase
        .from("thiet_bi_iot")
        .select(
          "id, so_seri, phan_tram_pin, lan_online_cuoi, trang_thai_hoat_dong",
        )
        .in("id", deviceIds)
        .limit(deviceIds.length);
      (devices || []).forEach((d) => {
        if (deviceIds.includes(d.id)) deviceMap[d.id] = d;
      });
    }

    // 5. Lấy live data
    const { data: liveData } = await supabase
      .from("trang_thai_live")
      .select(
        "nguoi_dung_tb_id, nhip_tim_live, spo2_live, muc_do_canh_bao, trang_thai_thiet_bi, thoi_gian_cap_nhat",
      )
      .in("nguoi_dung_tb_id", patientIds)
      .limit(patientIds.length);

    const liveMap = {};
    (liveData || []).forEach((l) => {
      if (patientIds.includes(l.nguoi_dung_tb_id))
        liveMap[l.nguoi_dung_tb_id] = l;
    });

    // 6. Merge
    const now = Date.now();
    const result = links.map((l) => {
      const pid = l.nguoi_dung_tb_id;
      const assign = assignMap[pid];
      const dev = assign ? deviceMap[assign.thiet_bi_id] : null;
      const live = liveMap[pid];
      return {
        patientId: pid,
        patientName: patientMap[pid]?.ho_ten || `ID:${pid?.slice(0, 8)}`,
        phone: patientMap[pid]?.so_dien_thoai,
        email: patientMap[pid]?.email,
        monitoringLevel: l.tan_suat_theo_doi,
        assignedAt: l.ngay_phan_cong,
        device: dev
          ? {
              deviceId: assign.thiet_bi_id,
              serial: dev.so_seri,
              battery: dev.phan_tram_pin,
              online: dev.lan_online_cuoi
                ? now - new Date(dev.lan_online_cuoi).getTime() < 60000
                : false,
              lastOnline: dev.lan_online_cuoi,
              assignedAt: assign.ngay_gan,
            }
          : null,
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

// GET /doctor/:doctorId/families — người nhà của bệnh nhân thuộc bác sĩ
app.get("/doctor/:doctorId/families", async (req, res) => {
  try {
    const { doctorId } = req.params;

    const { data: links } = await supabase
      .from("lien_ket_bac_si")
      .select("nguoi_dung_tb_id")
      .eq("nguoi_dung_bs_id", doctorId)
      .eq("trang_thai_hoat_dong", true);

    const patientIds = (links || [])
      .map((l) => l.nguoi_dung_tb_id)
      .filter(Boolean);
    if (patientIds.length === 0) return res.json({});

    const { data: families, error } = await supabase
      .from("lien_ket_nguoi_nha")
      .select(
        "nguoi_dung_tb_id, nguoi_dung_lq_id, moi_quan_he, la_nguoi_giam_sat_chinh, ngay_lien_ket",
      )
      .in("nguoi_dung_tb_id", patientIds)
      .eq("trang_thai_hoat_dong", true);

    if (error) throw error;

    const familyIds = [
      ...new Set(
        (families || []).map((f) => f.nguoi_dung_lq_id).filter(Boolean),
      ),
    ];
    const familyMap = {};
    if (familyIds.length > 0) {
      const { data: users } = await supabase
        .from("nguoi_dung")
        .select("id, ho_ten, so_dien_thoai, email")
        .in("id", familyIds)
        .limit(familyIds.length);
      (users || []).forEach((u) => {
        if (familyIds.includes(u.id)) familyMap[u.id] = u;
      });
    }

    const result = {};
    (families || []).forEach((f) => {
      if (!result[f.nguoi_dung_tb_id]) result[f.nguoi_dung_tb_id] = [];
      result[f.nguoi_dung_tb_id].push({
        familyId: f.nguoi_dung_lq_id,
        name: familyMap[f.nguoi_dung_lq_id]?.ho_ten,
        phone: familyMap[f.nguoi_dung_lq_id]?.so_dien_thoai,
        email: familyMap[f.nguoi_dung_lq_id]?.email,
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
    // 1. Lấy lịch sử gán đang active
    const { data: assignments, error } = await supabase
      .from("lich_su_gan_thiet_bi")
      .select("thiet_bi_id, nguoi_dung_tb_id, ngay_gan")
      .eq("trang_thai_hoat_dong", true);

    if (error) throw error;
    if (!assignments || assignments.length === 0) return res.json([]);

    // 2. Lấy thông tin thiết bị
    const deviceIds = [
      ...new Set(assignments.map((a) => a.thiet_bi_id).filter(Boolean)),
    ];
    const deviceMap = {};
    if (deviceIds.length > 0) {
      const { data: devices } = await supabase
        .from("thiet_bi_iot")
        .select(
          "id, so_seri, phan_tram_pin, lan_online_cuoi, trang_thai_hoat_dong, co_so_y_te_id",
        )
        .in("id", deviceIds)
        .limit(deviceIds.length);

      const csytIds = [
        ...new Set((devices || []).map((d) => d.co_so_y_te_id).filter(Boolean)),
      ];
      const csytMap = {};
      if (csytIds.length > 0) {
        const { data: csyts } = await supabase
          .from("co_so_y_te")
          .select("id, ten_co_so")
          .in("id", csytIds)
          .limit(csytIds.length);
        (csyts || []).forEach((c) => {
          csytMap[c.id] = c.ten_co_so;
        });
      }

      (devices || []).forEach((d) => {
        deviceMap[d.id] = { ...d, hospitalName: csytMap[d.co_so_y_te_id] };
      });
    }

    // 3. Lấy thông tin bệnh nhân
    const patientIds = [
      ...new Set(assignments.map((a) => a.nguoi_dung_tb_id).filter(Boolean)),
    ];
    const patientMap = {};
    if (patientIds.length > 0) {
      const { data: patients } = await supabase
        .from("nguoi_dung")
        .select("id, ho_ten, so_dien_thoai")
        .in("id", patientIds)
        .limit(patientIds.length);
      (patients || []).forEach((p) => {
        if (patientIds.includes(p.id)) patientMap[p.id] = p;
      });
    }

    const now = Date.now();
    const result = assignments.map((a) => {
      const dev = deviceMap[a.thiet_bi_id];
      return {
        deviceId: a.thiet_bi_id,
        serial: dev?.so_seri,
        battery: dev?.phan_tram_pin,
        online: dev?.lan_online_cuoi
          ? now - new Date(dev.lan_online_cuoi).getTime() < 60000
          : false,
        lastOnline: dev?.lan_online_cuoi,
        hospitalId: dev?.co_so_y_te_id,
        hospitalName: dev?.hospitalName,
        patientId: a.nguoi_dung_tb_id,
        patientName: patientMap[a.nguoi_dung_tb_id]?.ho_ten,
        patientPhone: patientMap[a.nguoi_dung_tb_id]?.so_dien_thoai,
        assignedAt: a.ngay_gan,
      };
    });

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
      .maybeSingle();

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
      .maybeSingle();

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
      supabase
        .from("co_so_y_te")
        .select("*")
        .eq("id", hospitalId)
        .maybeSingle(),
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
      .maybeSingle();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[GET /live/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MODULE 6: NGƯỜI DÙNG (theo vai trò)
// ============================================================

// GET /users?role=user_bs|user_tb|user_lq|sub_admin|admin
// Lọc người dùng theo vai trò qua bảng phan_quyen_nguoi_dung + vai_tro
app.get("/users", async (req, res) => {
  try {
    const { role, hospital_id } = req.query;

    // 1. Nếu có filter role → lấy qua phan_quyen_nguoi_dung
    if (role) {
      // Tìm vai_tro_id tương ứng
      const { data: vaiTro, error: vtErr } = await supabase
        .from("vai_tro")
        .select("id")
        .eq("ten_vai_tro", role)
        .maybeSingle();

      if (vtErr || !vaiTro) {
        return res
          .status(400)
          .json({ error: `Vai trò '${role}' không tồn tại` });
      }

      // Lấy danh sách user_id có vai trò đó
      const { data: pq, error: pqErr } = await supabase
        .from("phan_quyen_nguoi_dung")
        .select("nguoi_dung_id")
        .eq("vai_tro_id", vaiTro.id)
        .limit(500);

      if (pqErr) throw pqErr;
      if (!pq || pq.length === 0) return res.json([]);

      const userIds = pq.map((p) => p.nguoi_dung_id);

      // Lấy thông tin người dùng
      let query = supabase
        .from("nguoi_dung")
        .select(
          "id, ho_ten, email, so_dien_thoai, co_so_y_te_id, trang_thai_hoat_dong",
        )
        .in("id", userIds)
        .eq("trang_thai_hoat_dong", true);

      if (hospital_id) query = query.eq("co_so_y_te_id", hospital_id);

      const { data: users, error: uErr } = await query.order("ho_ten");
      if (uErr) throw uErr;

      return res.json((users || []).map((u) => ({ ...u, vai_tro: role })));
    }

    // 2. Không filter role → trả toàn bộ kèm vai trò
    const { data: allPQ, error: pqErr } = await supabase
      .from("phan_quyen_nguoi_dung")
      .select("nguoi_dung_id, vai_tro_id")
      .limit(1000);

    if (pqErr) throw pqErr;

    const { data: allVaiTro } = await supabase
      .from("vai_tro")
      .select("id, ten_vai_tro");

    const vtMap = {};
    (allVaiTro || []).forEach((v) => {
      vtMap[v.id] = v.ten_vai_tro;
    });

    // Map userId → [vai_tro]
    const userRoleMap = {};
    (allPQ || []).forEach((p) => {
      if (!userRoleMap[p.nguoi_dung_id]) userRoleMap[p.nguoi_dung_id] = [];
      if (vtMap[p.vai_tro_id])
        userRoleMap[p.nguoi_dung_id].push(vtMap[p.vai_tro_id]);
    });

    let query = supabase
      .from("nguoi_dung")
      .select(
        "id, ho_ten, email, so_dien_thoai, co_so_y_te_id, trang_thai_hoat_dong",
      )
      .eq("trang_thai_hoat_dong", true);

    if (hospital_id) query = query.eq("co_so_y_te_id", hospital_id);

    const { data: users, error: uErr } = await query.order("ho_ten").limit(500);
    if (uErr) throw uErr;

    const result = (users || []).map((u) => ({
      ...u,
      vai_tro: userRoleMap[u.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /users]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// THÊM: DỮ LIỆU THEO NGÀY
// ============================================================

// GET /vitals/days — danh sách các ngày có dữ liệu (UTC+7)
app.get("/vitals/days", async (req, res) => {
  try {
    // Thử RPC trước (nếu đã tạo function get_distinct_dates() trong Supabase)
    try {
      const { data: rpcData, error: rpcErr } =
        await supabase.rpc("get_distinct_dates");
      if (!rpcErr && Array.isArray(rpcData) && rpcData.length > 0) {
        const days = rpcData
          .map((r) =>
            typeof r === "string" ? r : r.ngay || r.date || String(r),
          )
          .filter(Boolean)
          .sort((a, b) => b.localeCompare(a));
        return res.json(days);
      }
    } catch (_) {
      /* RPC chưa tồn tại, bỏ qua */
    }

    // Fallback: lấy cột thoi_gian_do, deduplicate theo ngày UTC+7
    const { data: raw, error: rawErr } = await supabase
      .from("du_lieu_sinh_ton")
      .select("thoi_gian_do")
      .order("thoi_gian_do", { ascending: false })
      .limit(100000);

    if (rawErr) throw rawErr;

    const dateSet = new Set();
    (raw || []).forEach((r) => {
      if (!r.thoi_gian_do) return;
      const local = new Date(
        new Date(r.thoi_gian_do).getTime() + 7 * 3600 * 1000,
      );
      dateSet.add(local.toISOString().slice(0, 10));
    });

    res.json([...dateSet].sort((a, b) => b.localeCompare(a)));
  } catch (err) {
    console.error("[GET /vitals/days]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /vitals/by-date/:date — tất cả bản ghi của 1 ngày cụ thể (YYYY-MM-DD, UTC+7)
app.get("/vitals/by-date/:date", async (req, res) => {
  try {
    const { date } = req.params; // VD: 2026-03-31

    // Tính khoảng [00:00, 23:59:59] theo UTC+7 → convert sang UTC
    const startUTC = new Date(`${date}T00:00:00+07:00`).toISOString();
    const endUTC = new Date(`${date}T23:59:59+07:00`).toISOString();

    const { data: vitals, error: vitalsError } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id, thiet_bi_id, nguoi_dung_tb_id,
        nhip_tim, spo2, delta_nhip_tim, delta_spo2,
        che_do_lay_mau, thoi_gian_do
      `,
      )
      .gte("thoi_gian_do", startUTC)
      .lte("thoi_gian_do", endUTC)
      .order("thoi_gian_do", { ascending: false })
      .limit(2000);

    if (vitalsError) throw vitalsError;
    if (!vitals || vitals.length === 0) return res.json([]);

    // Lấy tên bệnh nhân
    const uniqueIds = [
      ...new Set(vitals.map((v) => v.nguoi_dung_tb_id).filter(Boolean)),
    ];
    const userMap = {};
    if (uniqueIds.length > 0) {
      const { data: users } = await supabase
        .from("nguoi_dung")
        .select("id, ho_ten")
        .in("id", uniqueIds)
        .limit(uniqueIds.length);
      (users || []).forEach((u) => {
        if (uniqueIds.includes(u.id)) userMap[u.id] = u.ho_ten;
      });
    }

    const result = vitals.map((v) => ({
      id: v.id,
      deviceId: v.thiet_bi_id,
      patientId: v.nguoi_dung_tb_id,
      patientName:
        userMap[v.nguoi_dung_tb_id] || `ID:${v.nguoi_dung_tb_id?.slice(0, 8)}`,
      heartRate: v.nhip_tim,
      spo2: v.spo2,
      deltaHeartRate: v.delta_nhip_tim,
      deltaSpo2: v.delta_spo2,
      samplingMode: v.che_do_lay_mau,
      time: v.thoi_gian_do,
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /vitals/by-date/:date]", err.message);
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
  console.log("  GET  /vitals/days");
  console.log("  GET  /vitals/by-date/:date");
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
