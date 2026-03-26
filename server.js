const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== CORS =====
app.use(
  cors({
    origin: ["https://AccountDoAn.github.io"], // 🔥 sửa ở đây
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  }),
);

app.options("*", cors());

app.use(express.json());

// ===== Supabase =====
const supabaseUrl = "https://xqhcxvnfiglxlzxlrtok.supabase.co";
const supabaseKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxaGN4dm5maWdseGx6eGxydG9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDQ2MDMsImV4cCI6MjA5MDAyMDYwM30.0xHS9QlLHSVdQFuLWtEmguzG-dRsC_VQXU8va64s5dQ";
const supabase = createClient(supabaseUrl, supabaseKey);

// ===== Test =====
app.get("/", (req, res) => {
  res.send("Health Monitor API v2 running");
});

// ==========================================
// 🧑‍⚕️ 1. Danh sách hồ sơ bệnh nhân
// ==========================================
app.get("/users", async (req, res) => {
  try {
    const { data, error } = await supabase.from("ho_so_userTB").select("*");

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ❤️ 2. Dữ liệu sinh tồn (history)
// ==========================================
app.get("/sinh-ton", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select("*")
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ❤️ 3. Sinh tồn theo userTB
// ==========================================
app.get("/sinh-ton/:userTB_id", async (req, res) => {
  try {
    const { userTB_id } = req.params;

    const { data, error } = await supabase
      .from("du_lieu_sinh_ton")
      .select("*")
      .eq("userTB_id", userTB_id)
      .order("thoi_gian_do", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ⚡ 4. LIVE data (real-time)
// ==========================================
app.get("/live/:userTB_id", async (req, res) => {
  try {
    const { userTB_id } = req.params;

    const { data, error } = await supabase
      .from("trang_thai_live")
      .select("*")
      .eq("userTB_id", userTB_id)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚨 5. Danh sách cảnh báo
// ==========================================
app.get("/alerts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("su_kien_cap_cuu")
      .select("*")
      .order("thoi_gian_phat", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🚨 6. Alert theo user
// ==========================================
app.get("/alerts/:userTB_id", async (req, res) => {
  try {
    const { userTB_id } = req.params;

    const { data, error } = await supabase
      .from("su_kien_cap_cuu")
      .select("*")
      .eq("userTB_id", userTB_id)
      .order("thoi_gian_phat", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
