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

// ===== Supabase =====
const supabase = createClient(
  "https://uacypltrrqmwoecqlipo.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhY3lwbHRycnFtd29lY3FsaXBvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2MTY4ODYsImV4cCI6MjA5MDE5Mjg4Nn0.BpGaMXMIWXWRgG38hKp4Khk-Dpw1CTKpb8GYwm1GyDc",
);

// ===== Test =====
app.get("/", (req, res) => {
  res.send("Health Monitor API v2 running");
});

// ==========================================
// 🧑‍⚕️ 1. Danh sách bệnh nhân
// ==========================================
app.get("/patients", async (req, res) => {
  try {
    const { data, error } = await supabase.from("ho_so_benh_nhan").select(`
        id,
        nguoi_dung_tb_id,
        nguoi_dung (
          ho_ten,
          so_dien_thoai
        )
      `);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ❤️ 2. Dữ liệu sinh tồn (history)
// ==========================================
app.get("/vitals", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select("*")
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ❤️ 3. Sinh tồn theo bệnh nhân
// ==========================================
app.get("/vitals/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select("*")
      .eq("nguoi_dung_tb_id", id)
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ⚡ 4. LIVE data
// ==========================================
app.get("/live/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("trang_thai_live")
      .select("*")
      .eq("nguoi_dung_tb_id", id)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚨 5. Danh sách cảnh báo
// ==========================================
app.get("/alerts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("canh_bao_suc_khoe")
      .select("*")
      .order("thoi_gian_phat_hien", { ascending: false })
      .limit(100);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚨 6. Alert theo bệnh nhân
// ==========================================
app.get("/alerts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("canh_bao_suc_khoe")
      .select("*")
      .eq("nguoi_dung_tb_id", id)
      .order("thoi_gian_phat_hien", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚨 7. Dashboard bác sĩ (VIEW)
// ==========================================
app.get("/doctor-dashboard", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("v_bang_dieu_khien_bac_si")
      .select("*");

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
