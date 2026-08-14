/* ============================================================================
   constants.js — shared config
   ----------------------------------------------------------------------------
   AUTH_MODE controls which backend the app talks to:
     "local"    -> js/store.js          (in-browser demo, no server, works instantly)
     "supabase" -> js/store.supabase.js (real Google Auth + Postgres + Storage + Realtime)

   To go live: follow README.md "Supabase setup", fill in js/supabase-config.js,
   run supabase/schema.sql, flip AUTH_MODE to "supabase" below, and swap the
   <script> includes in index.html (marked "BACKEND SWAP POINT").
   ========================================================================== */

const AUTH_MODE = "supabase";

// Developer/admin accounts: exempt from the campus geofence (can browse the
// map from anywhere while building/testing) and get a gold "DEV" treatment
// on their own pin so it's obvious in screenshots which dot is the builder,
// not a real student. Keep this list short and only ever your own account(s).
const ADMIN_EMAILS = ["24010101297@darshan.ac.in"];
function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}

// How long a user's last position update is trusted as "their GPS is on".
// Past this age with no fresh update — they turned location off, walked out
// of range, closed the tab, lost signal, whatever — their pin vanishes from
// everyone else's map instead of sitting there stale forever.
const PIN_STALE_MS = 45 * 1000; // 45s

const BRANCHES = [
  "B.Tech. - Computer Science & Engineering",
  "B.Tech. - Artificial Intelligence & Machine Learning",
  "B.Tech. - Civil Engineering",
  "B.Tech. - Electronics & Communication",
  "B.Tech. - Mechanical Engineering",
  "BCA",
  "B.Sc. (Information Technology)",
  "B.Sc. Honors - Computer Science",
  "B.Sc. Honors - Artificial Intelligence & Machine Learning",
  "B.Com.",
  "BBA",
  "BBA (Digital Marketing)",
  "BBA (Entrepreneurship & Family Business)",
  "B.Sc. (Microbiology)",
  "M.Tech. - Software Engineering",
  "M.Tech. - Structural Engineering",
  "M.Tech. - Transportation Engineering",
  "M.Tech. - Construction Project Management",
  "M.Tech. - Advanced Design & Manufacturing",
  "MCA",
  "MBA",
  "M.A. (Yoga)",
  "Diploma - Computer Engineering",
  "Diploma - Civil Engineering",
  "Diploma - Electrical Engineering",
  "Diploma - Mechanical Engineering",
  "Ph.D",
];
