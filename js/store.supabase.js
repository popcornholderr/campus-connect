/* ============================================================================
   store.supabase.js — real backend implementation (Supabase)
   ----------------------------------------------------------------------------
   Same method names/shapes as js/store.js, so js/app.js works unmodified.
   Requires: the Supabase JS CDN script + js/supabase-config.js loaded BEFORE
   this file (see index.html "BACKEND SWAP POINT" comment), and
   AUTH_MODE = "supabase" in js/constants.js.

   What actually happens here, end to end:
     - Login is real Google OAuth, restricted to the darshan.ac.in Google
       Workspace. Supabase does a full-page redirect to Google and back
       (not a popup) — that's a Supabase platform thing, not a bug.
     - Profile photos upload to a Supabase Storage bucket; the `users` table
       only ever stores the resulting public URL, never raw image data.
     - users/comments/likes are Postgres tables (see supabase/schema.sql).
       allUsers()/getComments()/getLikes() are one-shot reads. subscribeUsers()
       /subscribeMyActivity() are realtime (Supabase Realtime, Postgres
       change feeds) — app.js uses these when present to keep the map and
       notification dots live across real devices.
     - Access control is enforced by Postgres Row Level Security policies
       (supabase/schema.sql), not just this file — that's what actually stops
       someone from reading other people's comments by editing this JS.
   ========================================================================== */

function cfgIsPlaceholder() {
  const c = window.SUPABASE_CONFIG || {};
  return !c.url || !c.anonKey || c.url.includes("YOUR_PROJECT") || c.anonKey.includes("YOUR_ANON");
}
if (cfgIsPlaceholder()) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.innerHTML = `<div style="max-width:420px;margin:60px auto;padding:24px;font-family:sans-serif;line-height:1.6;">
      <h2>Supabase isn't configured yet</h2>
      <p>Fill in <code>js/supabase-config.js</code> with your project's URL and anon key
      (Supabase dashboard → Project Settings → API), then reload.</p>
      <p>See <code>README.md</code> → "Supabase setup" for the full walkthrough.</p>
    </div>`;
  });
  throw new Error("Supabase not configured — see js/supabase-config.js");
}

const sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
const PHOTO_BUCKET = "profile-photos";

/* Right after the Google OAuth redirect lands back here, the URL contains
   #access_token=... (implicit flow). Supabase's client parses that out of
   the hash itself on startup — but that parsing includes its own background
   call to validate the token, so it isn't instantly done the moment the
   page's JS starts running. Calling sb.auth.getSession() immediately can
   win that race and come back empty even though sign-in actually
   succeeded, which is exactly the "picks Google account, bounces back to
   the same login screen, no error" symptom.
   onAuthStateChange is the one signal Supabase itself guarantees fires
   only *after* that settling is done — it always fires once immediately
   with "INITIAL_SESSION" (session set if one exists, null otherwise) as
   soon as startup/URL-parsing is complete, then again on every later
   sign-in/sign-out. We wait for that first firing instead of racing it. */
const authReady = new Promise((resolve) => {
  // DEBUG: temporary logging so we can see exactly what Supabase's client
  // parsed out of the redirect URL and what event(s) actually fire. Remove
  // once sign-in is confirmed working.
  console.log("[auth-debug] location.hash on script load:", window.location.hash);
  const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
    console.log("[auth-debug] onAuthStateChange fired:", event, session);
    if (event === "INITIAL_SESSION") {
      resolve(session);
      sub.subscription.unsubscribe();
    }
  });
});

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id, enrollment: r.enrollment, email: r.email, name: r.name || "",
    username: r.username || "", photo: r.photo || null, age: r.age || "",
    branch: r.branch, semester: r.semester || 1, placeType: r.place_type || "hostel",
    place: r.place || "", relationship: r.relationship || "", phone: r.phone || "",
    social: r.social || "", pos: r.pos || { x: 0.35, y: 0.55 }, active: r.active !== false,
    onboarded: !!r.onboarded, lastSeen: r.last_seen || Date.now(),
    friends: r.friends || [], blocked: r.blocked || [],
  };
}
function userToRow(u) {
  return {
    id: u.id, enrollment: u.enrollment, email: u.email, name: u.name || "",
    username: u.username || "", username_lower: (u.username || "").toLowerCase(),
    photo: u.photo || null, age: u.age || null, branch: u.branch,
    semester: u.semester || 1, place_type: u.placeType || "hostel", place: u.place || "",
    relationship: u.relationship || "", phone: u.phone || "", social: u.social || "",
    pos: u.pos || { x: 0.35, y: 0.55 }, active: u.active !== false, onboarded: !!u.onboarded,
    last_seen: u.lastSeen || Date.now(), friends: u.friends || [], blocked: u.blocked || [],
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took too long (over ${Math.round(ms / 1000)}s) — check your connection and try again`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const Store = {
  async saveUser(profile) {
    // Base64 preview -> real file upload. Supabase Storage's upload() is a
    // plain signed REST call (no separate CORS config step like some other
    // providers need), so this is the fix for photos silently never
    // finishing: it always either resolves with a real URL or throws a
    // real, visible error within 20s.
    if (profile.photo && profile.photo.startsWith("data:")) {
      const blob = await withTimeout(fetch(profile.photo).then((r) => r.blob()), 15000, "Reading the photo");
      const path = `${profile.id}.jpg`;
      const { error: upErr } = await withTimeout(
        sb.storage.from(PHOTO_BUCKET).upload(path, blob, { upsert: true, contentType: blob.type || "image/jpeg" }),
        20000,
        "Uploading the photo"
      );
      if (upErr) throw new Error(upErr.message || "Photo upload failed");
      const { data } = sb.storage.from(PHOTO_BUCKET).getPublicUrl(path);
      // cache-bust so the new photo shows immediately instead of a stale
      // cached copy at the same URL
      profile.photo = `${data.publicUrl}?t=${Date.now()}`;
    }
    const { error } = await withTimeout(
      sb.from("users").upsert(userToRow(profile)),
      15000,
      "Saving your profile"
    );
    if (error) throw new Error(error.message || "Couldn't save your profile");
    return profile;
  },

  async setCurrentUser() { /* session handled by Supabase Auth itself; no-op */ },

  async getCurrentUser() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data } = await sb.from("users").select("*").eq("id", user.id).maybeSingle();
    return rowToUser(data);
  },

  async isUsernameTaken(username, excludeId) {
    const { data } = await sb.from("users").select("id").eq("username_lower", username.toLowerCase());
    return (data || []).some((r) => r.id !== excludeId);
  },

  async findByEnrollment(enrollment) {
    const { data } = await sb.from("users").select("*").eq("enrollment", enrollment).maybeSingle();
    return rowToUser(data);
  },

  async allUsers() {
    const { data } = await sb.from("users").select("*");
    return (data || []).map(rowToUser);
  },

  /** Realtime version of allUsers() — app.js uses this when available so
   *  the map shows everyone's position live, not just on manual refresh. */
  subscribeUsers(cb) {
    const channel = sb
      .channel("users-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "users" }, async () => {
        cb(await Store.allUsers());
      })
      .subscribe();
    return () => sb.removeChannel(channel);
  },

  async updatePosition(id, pos) {
    await sb.from("users").update({ pos, active: true, last_seen: Date.now() }).eq("id", id);
  },

  async toggleFriend(userId, targetId) {
    const { data } = await sb.from("users").select("friends").eq("id", userId).maybeSingle();
    const friends = (data && data.friends) || [];
    const next = friends.includes(targetId) ? friends.filter((f) => f !== targetId) : [...friends, targetId];
    await sb.from("users").update({ friends: next }).eq("id", userId);
    return next;
  },
  async getFriends(userId) {
    const { data } = await sb.from("users").select("friends").eq("id", userId).maybeSingle();
    return (data && data.friends) || [];
  },

  async toggleBlock(userId, targetId) {
    const { data } = await sb.from("users").select("blocked").eq("id", userId).maybeSingle();
    const blocked = (data && data.blocked) || [];
    const next = blocked.includes(targetId) ? blocked.filter((b) => b !== targetId) : [...blocked, targetId];
    await sb.from("users").update({ blocked: next }).eq("id", userId);
    return next;
  },
  async getBlocked(userId) {
    const { data } = await sb.from("users").select("blocked").eq("id", userId).maybeSingle();
    return (data && data.blocked) || [];
  },

  async addComment(fromId, toId, text) {
    const ts = Date.now();
    const { data, error } = await sb.from("comments").insert({ from_id: fromId, to_id: toId, text, ts }).select().single();
    if (error) throw new Error(error.message);
    return { id: data.id, fromId: data.from_id, toId: data.to_id, text: data.text, ts: data.ts };
  },
  /** Comments involving the signed-in user only — enforced both here
   *  (query shape) and server-side by RLS (supabase/schema.sql), which
   *  only lets a row's from_id/to_id read it, full stop. */
  async getComments() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return [];
    const { data } = await sb.from("comments").select("*").or(`from_id.eq.${user.id},to_id.eq.${user.id}`).order("ts", { ascending: false });
    return (data || []).map((d) => ({ id: d.id, fromId: d.from_id, toId: d.to_id, text: d.text, ts: d.ts }));
  },

  async addLike(fromId, toId) {
    const ts = Date.now();
    const { data, error } = await sb.from("likes").insert({ from_id: fromId, to_id: toId, ts }).select().single();
    if (error) throw new Error(error.message);
    return { id: data.id, fromId: data.from_id, toId: data.to_id, ts: data.ts };
  },
  async getLikes() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return [];
    const { data } = await sb.from("likes").select("*").or(`from_id.eq.${user.id},to_id.eq.${user.id}`).order("ts", { ascending: false });
    return (data || []).map((d) => ({ id: d.id, fromId: d.from_id, toId: d.to_id, ts: d.ts }));
  },

  /** Unread nav dots stay a per-device localStorage concern regardless of
   *  backend — no need to round-trip "did I see this tab" to the server. */
  async markTabSeen(tab) {
    const seen = JSON.parse(localStorage.getItem("cc_seen_tabs") || '{"map":true,"comments":true,"likes":true}');
    seen[tab] = true;
    localStorage.setItem("cc_seen_tabs", JSON.stringify(seen));
  },
  async getUnseenTabs() {
    return JSON.parse(localStorage.getItem("cc_seen_tabs") || '{"map":true,"comments":true,"likes":true}');
  },
  _markTabUnseen(tab) {
    const seen = JSON.parse(localStorage.getItem("cc_seen_tabs") || '{"map":true,"comments":true,"likes":true}');
    seen[tab] = false;
    localStorage.setItem("cc_seen_tabs", JSON.stringify(seen));
  },

  /** Realtime feed of comments/likes landing on `myId` from someone else —
   *  drives the on-map floating bubble/heart + red nav dots live, across
   *  real devices. Fires cb({type:'comment'|'like', fromId, text?, ts}). */
  subscribeMyActivity(myId, cb) {
    const chComments = sb
      .channel("comments-to-me")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "comments", filter: `to_id=eq.${myId}` }, (payload) => {
        const d = payload.new;
        if (d.from_id === myId) return;
        Store._markTabUnseen("comments");
        cb({ type: "comment", fromId: d.from_id, text: d.text, ts: d.ts });
      })
      .subscribe();
    const chLikes = sb
      .channel("likes-to-me")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "likes", filter: `to_id=eq.${myId}` }, (payload) => {
        const d = payload.new;
        if (d.from_id === myId) return;
        Store._markTabUnseen("likes");
        cb({ type: "like", fromId: d.from_id, ts: d.ts });
      })
      .subscribe();
    return () => { sb.removeChannel(chComments); sb.removeChannel(chLikes); };
  },
};

/* ----------------------------------------------------------------------
   Auth (Supabase mode) — Google OAuth restricted to the darshan.ac.in
   Google Workspace. Matches the same interface as the local Auth object
   in store.js so app.js's login/logout code doesn't need to branch.
   ---------------------------------------------------------------------- */
const Auth = {
  /** Kicks off a full-page redirect to Google and back — Supabase's OAuth
   *  flow doesn't do popups. app.js treats a `{redirecting:true}` result
   *  as "stop here, the page is about to navigate away"; the actual
   *  logged-in user comes back through tryCompleteSignIn() on the next
   *  page load, after the redirect completes. */
  async signInWithGoogle() {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { hd: "darshan.ac.in", prompt: "select_account" },
      },
    });
    if (error) throw new Error(error.message || "Google sign-in failed");
    return { redirecting: true };
  },

  /** Called on every page load. Resolves the current Supabase session (if
   *  any — including right after the OAuth redirect lands back here),
   *  hard-verifies the email domain (the `hd` param above is only a UI
   *  hint to Google, not an enforced restriction), and ensures a `users`
   *  row exists for first-time sign-ins. */
  async tryCompleteSignIn() {
    const session = await authReady;
    console.log("[auth-debug] tryCompleteSignIn resolved session:", session);
    if (!session || !session.user) return { loggedIn: false, user: null };

    const email = (session.user.email || "").toLowerCase();
    if (!email.endsWith("@darshan.ac.in")) {
      await sb.auth.signOut();
      return { loggedIn: false, user: null, error: "Please continue with your Darshan University (@darshan.ac.in) Google account." };
    }

    const uid = session.user.id;
    const { data: existing } = await sb.from("users").select("*").eq("id", uid).maybeSingle();
    if (existing) return { loggedIn: true, user: rowToUser(existing) };

    const enrollment = email.split("@")[0];
    const fresh = {
      id: uid, enrollment, email, name: session.user.user_metadata?.full_name || "",
      username: "", photo: session.user.user_metadata?.avatar_url || null, age: "",
      branch: BRANCHES[0], semester: 1, placeType: "hostel", place: "", relationship: "",
      phone: "", social: "", pos: { x: 0.35, y: 0.55 }, active: true,
      onboarded: false, lastSeen: Date.now(), friends: [], blocked: [],
    };
    const { error: insErr } = await sb.from("users").insert(userToRow(fresh));
    if (insErr) return { loggedIn: false, user: null, error: insErr.message };
    return { loggedIn: true, user: fresh };
  },

  async signOut() {
    await sb.auth.signOut();
  },
};
