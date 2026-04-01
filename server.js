const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== CORS =====
app.use(
  cors({
    origin: ["https://accountdoan.github.io"],
    methods: ["GET", "POST", "OPTIONS"],
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

// ===== Test =====
app.get("/", (req, res) => {
  res.send("Health Monitor API v2 running");
});
//================

// ==========================================
// ❤️ API: Lấy dữ liệu sinh tồn + cảnh báo
// ==========================================
app.get("/vitals", async (req, res) => {
  try {
    // 1. Lấy dữ liệu sinh tồn
    const { data: vitals, error: vitalsError } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id,
        nguoi_dung_tb_id,
        thiet_bi_id,
        nhip_tim,
        spo2,
        delta_nhip_tim,
        delta_spo2,
        thoi_gian_do
      `,
      )
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (vitalsError) throw vitalsError;

    // 2. Lấy danh sách user
    const userIds = [...new Set(vitals.map((v) => v.nguoi_dung_tb_id))];

    const { data: users, error: userError } = await supabase
      .from("nguoi_dung")
      .select("id, ho_ten")
      .in("id", userIds);

    if (userError) throw userError;

    // map user
    const userMap = {};
    users.forEach((u) => {
      userMap[u.id] = u.ho_ten;
    });

    // 3. Lấy cảnh báo tương ứng
    const vitalIds = vitals.map((v) => v.id);

    const { data: alerts, error: alertError } = await supabase
      .from("canh_bao_suc_khoe")
      .select(
        `
        du_lieu_sinh_ton_id,
        muc_do_nghiem_trong,
        trang_thai_xu_ly
      `,
      )
      .in("du_lieu_sinh_ton_id", vitalIds);

    if (alertError) throw alertError;

    // map alert
    const alertMap = {};
    alerts.forEach((a) => {
      alertMap[a.du_lieu_sinh_ton_id] = {
        severity: a.muc_do_nghiem_trong,
        status: a.trang_thai_xu_ly,
      };
    });

    // 4. Format dữ liệu trả về
    const result = vitals.map((v) => ({
      deviceId: v.thiet_bi_id,
      patientName: userMap[v.nguoi_dung_tb_id] || "Unknown",
      heartRate: v.nhip_tim,
      spo2: v.spo2,
      deltaHeartRate: v.delta_nhip_tim,
      deltaSpo2: v.delta_spo2,
      time: v.thoi_gian_do,
      alertLevel: alertMap[v.id]?.severity || "binh_thuong",
      alertStatus: alertMap[v.id]?.status || null,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ❤️ API theo từng bệnh nhân
// ==========================================
app.get("/vitals/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: vitals, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id,
        nguoi_dung_tb_id,
        thiet_bi_id,
        nhip_tim,
        spo2,
        delta_nhip_tim,
        delta_spo2,
        thoi_gian_do
      `,
      )
      .eq("nguoi_dung_tb_id", id)
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(vitals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    // 1. Lấy alert
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
        thoi_gian_xu_ly
      `,
      )
      .order("thoi_gian_phat_hien", { ascending: false })
      .limit(50);

    if (error) throw error;

    // 2. Lấy user
    const userIds = [...new Set(alerts.map((a) => a.nguoi_dung_tb_id))];

    const { data: users } = await supabase
      .from("nguoi_dung")
      .select("id, ho_ten")
      .in("id", userIds);

    const userMap = {};
    users.forEach((u) => (userMap[u.id] = u.ho_ten));

    // 3. Lấy dữ liệu sinh tồn liên quan
    const vitalIds = alerts.map((a) => a.du_lieu_sinh_ton_id);

    const { data: vitals } = await supabase
      .from("du_lieu_sinh_ton")
      .select(
        `
        id,
        thiet_bi_id,
        nhip_tim,
        spo2
      `,
      )
      .in("id", vitalIds);

    const vitalMap = {};
    vitals.forEach((v) => (vitalMap[v.id] = v));

    // 4. Format response
    const result = alerts.map((a) => ({
      alertId: a.id,
      patientId: a.nguoi_dung_tb_id,
      patientName: userMap[a.nguoi_dung_tb_id] || "Unknown",

      deviceId: vitalMap[a.du_lieu_sinh_ton_id]?.thiet_bi_id || null,
      heartRate: vitalMap[a.du_lieu_sinh_ton_id]?.nhip_tim || null,
      spo2: vitalMap[a.du_lieu_sinh_ton_id]?.spo2 || null,

      alertType: a.loai_canh_bao,
      severity: a.muc_do_nghiem_trong,
      status: a.trang_thai_xu_ly,

      detectedAt: a.thoi_gian_phat_hien,
      handledAt: a.thoi_gian_xu_ly,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Start =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
