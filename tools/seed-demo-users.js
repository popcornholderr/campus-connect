/* ============================================================================
   tools/seed-demo-users.js — creates a handful of fake student accounts so
   you can see the map/comments/likes actually working before real students
   sign up.
   ----------------------------------------------------------------------------
   Run locally (never in the browser — this needs the service_role key,
   which must never ship to the client):

     SUPABASE_URL="https://<ref>.supabase.co" \
     SUPABASE_SERVICE_ROLE_KEY="<paste freshly-rotated service_role key>" \
     node tools/seed-demo-users.js

   Requires: npm install @supabase/supabase-js  (run once, from this folder
   or anywhere — it's only used by this script, not shipped to the app).

   Each demo account:
     - is a real auth.users row (created via the admin API) with a random,
       never-used password — nobody can actually sign in as them, they
       exist purely so the `users` table's foreign key + RLS policies are
       satisfied exactly like a real student
     - gets a `users` row with a normalized {x,y} position picked from
       inside the current campus boundary polygon in js/config.js

   Safe to re-run: upserts by email, so running it twice won't duplicate
   accounts.
   ========================================================================== */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Positions are normalized {x,y} (0..1) picked from inside the mapped
// campus area — the same coordinate space js/geo.js writes real GPS fixes
// into. Spread around campus rather than clustered in one spot.
const DEMO_USERS = [
  { enrollment: "demo10001", name: "Aarav Mehta", username: "aarav_m", branch: "B.Tech. - Computer Science & Engineering", semester: 5, place: "Rajkot", relationship: "Single", age: 20, pos: { x: 0.30, y: 0.55 } },
  { enrollment: "demo10002", name: "Diya Shah", username: "diya_shah", branch: "BCA", semester: 3, place: "Morbi", relationship: "Single", age: 19, pos: { x: 0.42, y: 0.38 } },
  { enrollment: "demo10003", name: "Kabir Joshi", username: "kabir_j", branch: "B.Tech. - Mechanical Engineering", semester: 7, place: "Jamnagar", relationship: "In a relationship", age: 21, pos: { x: 0.27, y: 0.63 } },
  { enrollment: "demo10004", name: "Meera Patel", username: "meera_p", branch: "MBA", semester: 2, place: "Rajkot", relationship: "Single", age: 22, pos: { x: 0.36, y: 0.48 } },
  { enrollment: "demo10005", name: "Yash Rathod", username: "yash_r", branch: "B.Tech. - Civil Engineering", semester: 5, place: "Gondal", relationship: "Single", age: 20, pos: { x: 0.24, y: 0.57 } },
];
const EMAIL_DOMAIN = "@darshan.ac.in";

async function main() {
  for (const u of DEMO_USERS) {
    const email = `${u.enrollment}${EMAIL_DOMAIN}`;
    const password = require("crypto").randomBytes(24).toString("hex"); // random, never communicated — nobody can sign in as this account

    let userId;
    const { data: created, error: createErr } = await sb.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr) {
      if (String(createErr.message || "").toLowerCase().includes("already been registered")) {
        const { data: list } = await sb.auth.admin.listUsers();
        const existing = list?.users?.find((x) => x.email === email);
        if (!existing) { console.error(`Skipping ${email}: couldn't find existing auth user`, createErr.message); continue; }
        userId = existing.id;
      } else {
        console.error(`Failed to create auth user ${email}:`, createErr.message);
        continue;
      }
    } else {
      userId = created.user.id;
    }

    const row = {
      id: userId, enrollment: u.enrollment, email, name: u.name,
      username: u.username, username_lower: u.username.toLowerCase(),
      age: u.age, branch: u.branch, semester: u.semester, place_type: "hostel",
      place: u.place, relationship: u.relationship, pos: u.pos,
      active: true, onboarded: true, last_seen: Date.now(),
      friends: [], blocked: [],
    };
    const { error: upsertErr } = await sb.from("users").upsert(row);
    if (upsertErr) console.error(`Failed to upsert users row for ${email}:`, upsertErr.message);
    else console.log(`✓ ${u.name} (${email})`);
  }
  console.log("Done. Reload the app — demo pins should now be on the map.");
}

main();
