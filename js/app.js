/* ============================================================================
   app.js — Campus Connect application logic
   ========================================================================== */

const App = {
  me: null,
  regions: [],
  scope: "everyone",
  // Set while looking at one specific group's map inside Friends only
  // mode (see openGroupMap()/closeGroupMap()) — null the rest of the time,
  // including while browsing the groups list itself.
  currentGroupId: null,
  activeTab: "map",
  highlightedPinId: null,
  openInfoCardFor: null,
  commentThreadUser: null, // for comments tab search-narrowing
  likeThreadUser: null,
  bubbleTimers: {},
  simTimer: null,
  // Comment/like events that arrived from someone while we weren't looking
  // at the map — held here instead of being dropped, and played back (see
  // flushPendingMapActivity()) the next time the map is actually on
  // screen, so "user2 wasn't on the map tab at that exact second" no
  // longer means the bubble/heart next to user1's pin just never happens.
  pendingMapActivity: [],
};

// Safety net: surface any async error that slips through without its own
// try/catch (a network hiccup mid-await, a Supabase call that rejects in
// a spot we didn't anticipate, etc.) as a toast instead of it disappearing
// into the console — that silent-failure pattern is exactly what made
// things like "Save changes" look broken with zero feedback.
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled error:", e.reason);
  const msg = e.reason && e.reason.message ? e.reason.message : "Something went wrong";
  toast("Something went wrong: " + msg);
});

/* ---------------------------------------------------------------- helpers */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function show(el) { el.classList.add("show"); }
function hide(el) { el.classList.remove("show"); }
function initials(name) {
  return (name || "?").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}
function avatarHTML(user, size) {
  if (user.photo) return `<img src="${user.photo}" alt="${user.name}" />`;
  return `<span class="initials" style="transform:none;">${initials(user.name)}</span>`;
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function fmtMonth(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function enrollmentFromEmail(email) { return (email || "").split("@")[0]; }
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._hideTimer);
  // Longer messages (like the new save-timeout diagnostics) need more time
  // on screen than a quick "Profile updated" — scale the dismiss delay with
  // message length instead of a fixed 2.2s that cut them off mid-read.
  const dismissAfter = Math.min(7000, Math.max(2200, msg.length * 60));
  t._hideTimer = setTimeout(() => t.classList.remove("show"), dismissAfter);
}
function nearestRegion(pos) {
  if (!pos || !App.regions.length) return "On campus";
  let best = null, bestD = Infinity;
  App.regions.forEach((r) => {
    const d = Math.hypot(r.x - pos.x, r.y - pos.y);
    if (d < bestD) { bestD = d; best = r; }
  });
  return best ? best.name : "On campus";
}

/* ---------------------------------------------------------------- viewport height fix
   Mobile browsers (esp. Android Chrome/WebViews and older iOS Safari)
   don't always resize 100vh/100dvh correctly when the address bar or the
   on-screen keyboard shows/hides — the app-shell would end up taller than
   the *actually visible* area, shoving the bottom nav off the bottom of
   the screen. We track the real visible height ourselves (visualViewport
   when available, since it reflects the keyboard too) and expose it as a
   CSS var #app-shell's height calc() reads, as a robust fallback on top
   of dvh. */
function setAppHeight() {
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", h + "px");
}
setAppHeight();
window.addEventListener("resize", setAppHeight);
window.addEventListener("orientationchange", setAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", setAppHeight);
  window.visualViewport.addEventListener("scroll", setAppHeight);
}

/* ---------------------------------------------------------------- image resize
   Downscale + recompress any uploaded photo client-side before it ever
   touches a data URL / upload. Real phone camera photos are commonly
   3-12MB — that's slow (or outright times out) to upload on campus wifi,
   and was the main reason profile-photo uploads looked "stuck"/broken.
   Shrinking to a sensible avatar size first makes the upload fast and
   reliable, and keeps it comfortably under the 5MB Storage rule cap. */
function resizeImageFile(file, maxDim = 720, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that image"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't read that image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------- boot */
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener("appinstalled", () => {
  // Fires the moment the OS finishes installing it — move straight into
  // the app rather than making the person tap anything else.
  proceedPastInstallGate();
});

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function looksLikeSignInLink() {
  // Someone landing here mid-way through the Google OAuth redirect
  // shouldn't be interrupted by the install gate — that would strand
  // them right after they signed in. Supabase's redirect comes back
  // with either a `?code=...` (PKCE, the default) or `#access_token=...`
  // (implicit flow) in the URL — either one means "let them straight
  // through, don't show the install screen this time."
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.has("code")) return true;
    if (window.location.hash.includes("access_token")) return true;
    return false;
  } catch (e) { return false; }
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* non-fatal */ });
  }
}

function wireInstallScreen() {
  if (isIOSDevice() && !isStandaloneDisplay()) {
    show($("#install-ios-steps"));
    $("#btn-install").textContent = "How to install";
  }
  $("#btn-install").addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (choice.outcome === "accepted") return; // appinstalled will advance us
      // "dismissed" — let them try again or continue in browser below.
    } else if (isIOSDevice()) {
      $("#install-ios-steps").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      toast("Use your browser's menu → Install app / Add to Home Screen");
    }
  });
  $("#btn-skip-install").addEventListener("click", () => proceedPastInstallGate());
}

async function proceedPastInstallGate() {
  const result = await Auth.tryCompleteSignIn();
  // Clean OAuth params out of the URL either way, so a refresh doesn't
  // try to "complete" the same sign-in twice.
  if (window.location.search || window.location.hash) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  const existing = result.user;
  if (existing && existing.onboarded) {
    App.me = existing;
    goTo("screen-gps"); // still need to (re)confirm GPS each fresh load, as required
  } else if (existing) {
    App.me = existing;
    goTo("screen-onboarding");
    renderOnboardStep(1);
  } else {
    goTo("screen-login");
    if (result.error) {
      const el = $("#login-error");
      el.textContent = result.error;
      el.style.display = "block";
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  populateBranchSelect();
  await loadRegions();
  wireLogin();
  wireOnboarding();
  wireGps();
  wireMap();
  wireBottomNav();
  wireCommentsTab();
  wireLikesTab();
  wireProfileTab();
  wireOtherProfile();
  wireModals();
  wireGroups();
  wireInstallScreen();
  registerServiceWorker();

  if (isStandaloneDisplay() || looksLikeSignInLink()) {
    await proceedPastInstallGate();
  } else {
    goTo("screen-install");
  }
});

async function loadRegions() {
  try {
    const res = await fetch("assets/regions.json");
    App.regions = await res.json();
  } catch (e) {
    App.regions = [];
  }
}

function populateBranchSelect() {
  const sel = $("#input-branch");
  sel.innerHTML = BRANCHES.map((b) => `<option value="${b}">${b}</option>`).join("");
}

// Only these screens are "inside" the app, i.e. only reachable after a
// signed-in, onboarded user — the bottom nav (Map/Comments/Likes/Profile)
// should only ever be visible on these, never on install/login/onboarding/GPS.
const SCREENS_WITH_BOTTOM_NAV = new Set([
  "screen-map", "screen-groups", "screen-comments", "screen-likes", "screen-profile", "screen-other-profile",
]);

function goTo(screenId) {
  $all(".screen").forEach((s) => s.classList.remove("active"));
  $("#" + screenId).classList.add("active");
  // A modal left open from before (e.g. the person backgrounded the app,
  // or a screen change happened programmatically) must never survive a
  // navigation — otherwise it keeps floating over whatever screen loads
  // next, and can visually stack with a second modal opened on top of it.
  closeAllModals();
  const showNav = SCREENS_WITH_BOTTOM_NAV.has(screenId);
  $("#app-shell").classList.toggle("bottom-nav-visible", showNav);
  // Line the glass pill up as soon as the bar actually becomes visible —
  // covers goTo() calls that bypass switchTab() entirely (e.g. landing on
  // the map straight after GPS confirmation), not just tab switches.
  if (showNav) moveNavPill();
}

/* ======================================================================
   LOGIN
   ====================================================================== */
function wireLogin() {
  const hasRealBackend = typeof Auth.signInWithGoogle === "function";

  if (hasRealBackend) {
    // Real backend attached (Supabase): only the Google button is usable.
    $("#btn-google-login").style.display = "flex";
    $("#btn-google-login").addEventListener("click", async () => {
      const btn = $("#btn-google-login");
      btn.disabled = true;
      $("#login-error").style.display = "none";
      try {
        const result = await Auth.signInWithGoogle();
        if (result.redirecting) return; // page is navigating away to Google now
      } catch (e) {
        $("#login-error").textContent = e.message || "Couldn't sign you in — try again";
        $("#login-error").style.display = "block";
        btn.disabled = false;
      }
    });
    return;
  }

  // Local demo mode: no real backend attached, so there's no Google account
  // to verify — instant sign-in by typing any enrollment number instead.
  $("#field-enroll").style.display = "block";
  $("#btn-login").style.display = "block";
  const input = $("#input-enroll");
  input.addEventListener("input", () => {
    $("#preview-email").textContent = input.value.trim() || "enrollment";
  });
  $("#btn-login").addEventListener("click", async () => {
    const val = input.value.trim();
    const field = $("#field-enroll");
    const valid = /^[A-Za-z0-9]{4,15}$/.test(val);
    if (!valid) { field.classList.add("has-error"); return; }
    field.classList.remove("has-error");

    const result = await Auth.sendLoginLink(val);
    const user = result.user;
    App.me = user;
    if (user.onboarded) {
      goTo("screen-gps");
    } else {
      goTo("screen-onboarding");
      renderOnboardStep(1);
    }
  });
}

/* ======================================================================
   ONBOARDING
   ====================================================================== */
let obStep = 1;
const OB_TOTAL = 3;

function renderOnboardStep(n) {
  obStep = n;
  $("#step-dots").innerHTML = Array.from({ length: OB_TOTAL })
    .map((_, i) => `<span class="${i < n ? "done" : ""}"></span>`).join("");
  $all(".ob-step").forEach((el) => (el.style.display = Number(el.dataset.step) === n ? "block" : "none"));
  $("#btn-ob-back").style.visibility = n === 1 ? "hidden" : "visible";
  $("#btn-ob-next").textContent = n === OB_TOTAL ? "Finish & see the map" : "Continue";

  // pre-fill from App.me
  const m = App.me;
  if (n === 1) {
    if (m.photo) { $("#avatar-circle").innerHTML = `<img src="${m.photo}"/>`; }
    $("#input-name").value = m.name || "";
    $("#input-username").value = m.username || "";
  }
  if (n === 2) {
    $("#input-age").value = m.age || "";
    $("#input-branch").value = m.branch || BRANCHES[0];
    $("#input-semester").value = m.semester || 1;
  }
  if (n === 3) {
    setPill("#toggle-place", m.placeType || "hostel");
    $("#input-place-detail").value = m.place || "";
    setPill("#toggle-relationship", m.relationship || "");
    $("#input-phone").value = m.phone || "";
    $("#input-social").value = m.social || "";
  }
}
function setPill(sel, val) {
  $all(sel + " button").forEach((b) => b.classList.toggle("selected", b.dataset.val === val));
}

function wireOnboarding() {
  $("#avatar-circle").addEventListener("click", () => $("#avatar-input").click());
  $("#avatar-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Please choose an image file"); return; }
    $("#avatar-circle").innerHTML = `<span class="plus">…</span>`;
    try {
      const dataUrl = await resizeImageFile(file);
      App.me.photo = dataUrl;
      $("#avatar-circle").innerHTML = `<img src="${dataUrl}"/>`;
    } catch (err) {
      console.error("Avatar resize failed:", err);
      toast("Couldn't use that photo — try a different one");
      $("#avatar-circle").innerHTML = App.me.photo ? `<img src="${App.me.photo}"/>` : `<span class="plus">+</span>`;
    }
  });

  $all("#toggle-place button").forEach((b) =>
    b.addEventListener("click", () => setPill("#toggle-place", b.dataset.val))
  );
  $all("#toggle-relationship button").forEach((b) =>
    b.addEventListener("click", () => setPill("#toggle-relationship", b.dataset.val))
  );

  $("#btn-ob-back").addEventListener("click", () => { if (obStep > 1) renderOnboardStep(obStep - 1); });

  $("#btn-ob-next").addEventListener("click", async () => {
    // Guard against double-taps firing a second save while the first is
    // still in flight, and give every step visible "Saving…" feedback +
    // an actual error message instead of quietly doing nothing when a
    // save fails (offline, permission issue, etc.) — previously these
    // steps had no error handling at all, so any hiccup here just looked
    // like the button was broken and the profile "wasn't saving".
    const btn = $("#btn-ob-next");
    if (btn.disabled) return;
    const originalLabel = btn.textContent;

    async function saveStep(mutate, onSuccess) {
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        mutate();
        await Store.saveUser(App.me);
        onSuccess();
      } catch (err) {
        console.error("Onboarding save failed:", err);
        const code = err && err.code || "";
        const msg = code === "permission-denied"
          ? "Couldn't save — you don't have permission to update this profile."
          : code.startsWith("storage/")
          ? "Couldn't upload your photo (" + code.replace("storage/", "") + "). Try a smaller image or a different one."
          : !navigator.onLine
          ? "You're offline — connect to the internet and try again."
          : "Couldn't save: " + (err && err.message ? err.message : "unknown error") + ".";
        toast(msg);
      } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }

    if (obStep === 1) {
      const nameField = $("#input-name").value.trim();
      const uname = $("#input-username").value.trim();
      if (!App.me.photo) { toast("Please upload a profile photo"); return; }
      if (!nameField) { toast("Please enter your name"); return; }
      if (!uname || !/^[a-zA-Z0-9_.]{3,20}$/.test(uname)) { toast("Enter a valid username (3-20 chars)"); return; }

      btn.disabled = true;
      btn.textContent = "Checking…";
      let taken;
      try {
        taken = await Store.isUsernameTaken(uname, App.me.id);
      } catch (err) {
        console.error("Username check failed:", err);
        toast(!navigator.onLine ? "You're offline — connect to the internet and try again." : "Couldn't check that username right now — try again.");
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (taken) {
        $("#field-username").classList.add("has-error");
        return;
      }
      $("#field-username").classList.remove("has-error");
      await saveStep(() => { App.me.name = nameField; App.me.username = uname; }, () => renderOnboardStep(2));
      return;
    }
    if (obStep === 2) {
      const age = Number($("#input-age").value);
      if (!age || age < 15 || age > 70) { toast("Enter a valid age"); return; }
      await saveStep(() => {
        App.me.age = age;
        App.me.branch = $("#input-branch").value;
        App.me.semester = Number($("#input-semester").value);
      }, () => renderOnboardStep(3));
      return;
    }
    if (obStep === 3) {
      const placeType = $("#toggle-place button.selected")?.dataset.val;
      const placeDetail = $("#input-place-detail").value.trim();
      const relationship = $("#toggle-relationship button.selected")?.dataset.val;
      if (!placeType || !placeDetail) { toast("Tell us where you live"); return; }
      if (!relationship) { toast("Relationship status is required"); return; }
      await saveStep(() => {
        App.me.placeType = placeType;
        App.me.place = placeDetail;
        App.me.relationship = relationship;
        App.me.phone = $("#input-phone").value.trim();
        App.me.social = $("#input-social").value.trim();
        App.me.onboarded = true;
      }, () => goTo("screen-gps"));
    }
  });
}

/* ======================================================================
   GPS
   ----------------------------------------------------------------------
   Important, honest caveat: a website (even installed to the home
   screen / opened full-screen as a PWA) can only ever get "Allow while
   using the app" from the browser's Geolocation permission — there is no
   web equivalent of native apps' "Always Allow" background-location
   permission. The browser will only report a position while this tab/app
   is open and in the foreground. The GPS screen copy below is written to
   reflect that honestly instead of promising background tracking that
   isn't technically possible from a browser.
   ====================================================================== */
function wireGps() {
  $("#btn-enable-gps").addEventListener("click", async () => {
    // If the browser already knows the permission is blocked (e.g. the
    // person denied it on an earlier visit), calling watchPosition again
    // won't even show a prompt — it just silently errors, which is what
    // made this button look like it "did nothing". Detect that case
    // up front and give clear instructions instead.
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const status = await navigator.permissions.query({ name: "geolocation" });
        if (status.state === "denied") {
          toast("Location is blocked for this site — enable it in your browser's site settings, then tap this again");
          return;
        }
      } catch (e) { /* Permissions API not supported for this query — fall through and just try. */ }
    }
    startLocationTracking();
  });
}

let firstFixReceived = false;
let locationTrackingStarted = false;
let demoFallbackTimer = null;

/** Right after GPS is confirmed, drop the person into whichever mode they
 *  were last using — Everyone (with the map straight away) for a brand new
 *  profile, since App.me.mode defaults to "everyone", or Friends only
 *  mode's groups list if that's what they had open when they last closed
 *  the app (App.me.mode is persisted the moment it's changed — see
 *  setScope()). */
function enterAppForCurrentMode() {
  const mode = (App.me && App.me.mode) || "everyone";
  setScope(mode);
}

function startLocationTracking() {
  // Guard against wiring this up more than once (e.g. the person backs
  // out to this screen and taps Allow again) — that used to register a
  // second set of listeners and could run a real GPS watch alongside a
  // leftover demo walk, fighting each other and making the pin jump
  // around instead of the "still not working" look staying consistent.
  if (locationTrackingStarted) { enterAppForCurrentMode(); return; }
  locationTrackingStarted = true;

  show($("#geo-loading"));
  // Absolute backstop: whatever else happens (fix arrives, GPS errors,
  // demo fallback kicks in), never let the "Locating you…" pill sit on
  // screen for more than 5s — it's a status hint, not something that
  // should be able to block the map indefinitely.
  const geoLoadingHardTimeout = setTimeout(() => hide($("#geo-loading")), 5000);

  Geo.onUpdate(async (fix) => {
    if (fix.error) {
      // Permission denied or unsupported (e.g. testing on desktop, off-campus).
      // Fall back to a simulated on-campus walk so the app is still demoable.
      if (!firstFixReceived) {
        toast("Location unavailable — showing a demo position instead");
        Geo.startDemoWalk();
      }
      // If we'd already been getting real fixes, a single error here is
      // usually just a transient GPS hiccup (indoors for a second, one
      // timed-out fix) — NOT a sign location was actually turned off.
      // watchPosition keeps retrying on its own and will call us again
      // with a good fix shortly, so we deliberately do nothing drastic
      // here: no instant deactivate, no resetting firstFixReceived (doing
      // that used to make the very next hiccup look like "never got a fix"
      // and kick off the demo walk on top of your real tracking — that
      // was the actual cause of pins vanishing/glitching while GPS was
      // still on). If the signal is genuinely and lastingly gone, the pin
      // fades on its own via the staleness check in isPinVisible() once
      // PIN_STALE_MS passes with no fresh update — same mechanism as
      // everyone else's pins, self-healing the moment a real fix returns.
      return;
    }
    // A real fix landed — make sure it's the only thing driving the pin.
    clearTimeout(demoFallbackTimer);
    clearTimeout(geoLoadingHardTimeout);
    if (!fix.demo) Geo.stopDemoWalk();
    firstFixReceived = true;
    handleFix(fix);
  });
  Geo.start();
  enterAppForCurrentMode();

  // Safety net: if a real fix hasn't arrived in 4s (desktop browser / no GPS
  // hardware / permission dialog ignored), switch to the demo walk so the
  // reviewer can still see live pin movement. Cancelled above the instant
  // a real fix does arrive, even if it's a little late.
  demoFallbackTimer = setTimeout(() => {
    if (!firstFixReceived) {
      toast("Using a demo walk — no live GPS detected on this device");
      Geo.startDemoWalk();
    }
  }, 4000);
}

let hasCenteredOnUser = false;

async function handleFix(fix) {
  if (!App.me) return; // not signed in / not ready yet — ignore this fix
  hide($("#geo-loading"));
  // Admin/developer accounts (see ADMIN_EMAILS in constants.js) always get
  // treated as "inside campus" so the map is browsable/testable from
  // anywhere — everyone else still gets the real geofence.
  const isAdmin = isAdminEmail(App.me.email);
  const inside = isAdmin || fix.inside !== false;
  $("#oob-screen").classList.toggle("show", !inside);
  if (!inside) {
    // Walked outside the campus geofence — freeze the pin here instead of
    // moving it further, and just don't refresh it. If this is a real,
    // sustained exit, the pin fades on its own once PIN_STALE_MS passes
    // with no fresh update (same staleness rule everyone else's pin uses).
    // We deliberately don't force-deactivate on the very first out-of-
    // bounds fix — right at the campus boundary a fix or two can flicker
    // in/out, and instantly toggling active off/on for that read as pins
    // randomly vanishing.
    return;
  }

  App.me.pos = { x: fix.nx, y: fix.ny };
  await Store.updatePosition(App.me.id, App.me.pos); // also flips active back to true
  App.me.active = true;
  // renderMapPins() pushes this same local App.me object straight into
  // isPinVisible()'s staleness check instead of re-fetching your own row
  // (see the comment on that push in renderMapPins()) — so lastSeen has to
  // be refreshed right here too, not just on the server. Without this, the
  // very first render after opening the app was reading whatever lastSeen
  // your account had from your PREVIOUS session (however old that was),
  // filtering your own pin out as "stale" even with a brand new GPS fix in
  // hand — and it would only start working after a restart, once that
  // stale value on the server had finally been overwritten by the tail end
  // of the broken session.
  App.me.lastSeen = Date.now();
  renderMapPins();

  // First time we get a real location, snap the view to it and zoom in —
  // the same "here's you" behaviour as tapping the location dot when you
  // first open Google Maps — instead of leaving the person looking at
  // whatever part of the map happened to be showing.
  if (!hasCenteredOnUser && MapView.el) {
    hasCenteredOnUser = true;
    MapView.centerOn(fix.nx, fix.ny, Math.max(MapView.zoom, 2.5), true);
  }
}

/* ======================================================================
   MAP SCREEN
   ====================================================================== */
/** Starts realtime subscriptions + the stale-pin watch exactly once, no
 *  matter which screen (Everyone map or Friends only mode's groups list)
 *  the person lands on first — both need live updates, but only the map
 *  screen itself also needs MapView initialized (see enterMapFirstTime). */
let realtimeStarted = false;
function startRealtimeAndActivity() {
  if (realtimeStarted) return;
  realtimeStarted = true;
  startStaleGpsWatch();

  if (typeof Store.subscribeUsers === "function") {
    // Real backend mode: real students' pins (and mode/group changes) update
    // live, no polling needed.
    Store.subscribeUsers(() => {
      if (App.activeTab === "map" && App.scope === "everyone") renderMapPins();
      if (App.activeTab === "map" && App.currentGroupId) renderMapPins();
    });
  }
  if (typeof Store.subscribeMyActivity === "function" && App.me) {
    // Real backend mode: real comments/likes from other students land here
    // live and drive the same bubble/heart/red-dot UI the local demo
    // simulates with a timer.
    Store.subscribeMyActivity(App.me.id, async (evt) => {
      const all = await Store.allUsers();
      const actor = all.find((u) => u.id === evt.fromId);
      if (!actor) return;
      if (evt.type === "comment") showOrQueueActivity("comment", actor, evt.text);
      if (evt.type === "like") showOrQueueActivity("like", actor);
      refreshNavDots();
    });
  } else {
    // Local demo mode: no real second user, so simulate classmate activity.
    startActivitySimulation();
  }
  if (typeof Store.subscribeGroupsAndInvites === "function" && App.me) {
    // Real backend mode: a new invite landing on us, or a group we're in
    // changing (new member, etc.), refreshes the groups list / inbox badge
    // / open group map live.
    Store.subscribeGroupsAndInvites(App.me.id, () => {
      renderInboxBadge();
      if ($("#screen-groups").classList.contains("active")) renderGroupsList();
      if (App.currentGroupId) renderMapPins();
    });
  }
  refreshNavDots();
  renderInboxBadge();
}

function enterMapFirstTime() {
  // Deferred to first real appearance of the map (rather than at boot)
  // because #map-scroll is display:none — and therefore has zero size —
  // until its screen becomes active, which would make all the "cover the
  // viewport" math below come out as zero.
  if (!MapView.el) MapView.init($("#map-canvas"), $("#map-scroll"));
  else { MapView._sizeCanvas(); MapView._clampAndApply(); }
  renderMapPins();
  startRealtimeAndActivity();
}

/** Everyone mode vs. Friends only mode lives here — the single place that
 *  decides which top-level screen to show, persists the choice (both to
 *  App.me.mode locally and to the backend, via Store.setMode) so it's
 *  remembered the next time the app opens, and — for Friends only mode —
 *  makes the person's pin vanish from the shared Everyone map (handled by
 *  the mode filter inside renderMapPins()). */
async function setScope(scope) {
  App.scope = scope;
  App.currentGroupId = null;
  hideGroupMapChrome();
  $all(".scope-toggle button").forEach((b) => b.classList.toggle("selected", b.dataset.scope === scope));

  if (App.me) {
    App.me.mode = scope;
    // Persisted immediately (not just on app-close) so the "vanish from
    // Everyone's map" effect is instant for everyone else too, and so the
    // last-used mode is already saved the moment it's chosen.
    try { await Store.setMode(App.me.id, scope); } catch (err) { console.error("setMode failed:", err); }
  }

  App.activeTab = "map";
  $all("#bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "map"));

  if (scope === "everyone") {
    goTo("screen-map");
    enterMapFirstTime();
  } else {
    goTo("screen-groups");
    startRealtimeAndActivity();
    renderGroupsList();
  }
}

/** Shows/hides the map screen's topbar between "Everyone/Friends only
 *  switch" and "‹ Groups / group name / Invite" (used while looking at one
 *  specific group's map). */
function hideGroupMapChrome() {
  $("#map-topbar").classList.remove("group-mode");
}

async function openGroupMap(groupId) {
  const group = await Store.getGroup(groupId);
  if (!group) { toast("That group is no longer available."); return; }
  App.currentGroupId = groupId;
  $("#group-map-title").textContent = group.name;
  $("#map-topbar").classList.add("group-mode");
  App.activeTab = "map";
  $all("#bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "map"));
  goTo("screen-map");
  if (!MapView.el) MapView.init($("#map-canvas"), $("#map-scroll"));
  else { MapView._sizeCanvas(); MapView._clampAndApply(); }
  renderMapPins();
  startRealtimeAndActivity();
}

function closeGroupMap() {
  App.currentGroupId = null;
  hideGroupMapChrome();
  goTo("screen-groups");
  renderGroupsList();
}

function wireMap() {
  $all(".scope-toggle button").forEach((b) => {
    b.addEventListener("click", () => setScope(b.dataset.scope));
  });

  $("#btn-back-to-groups").addEventListener("click", closeGroupMap);
  $("#btn-invite-to-group").addEventListener("click", () => {
    if (App.currentGroupId) openInviteModal(App.currentGroupId);
  });

  $("#btn-locate-me").addEventListener("click", () => {
    if (!App.me || !App.me.pos) { toast("Still finding your location…"); return; }
    closeInfoCard();
    // Focus-zoom in on your own pin, same idea as the very first
    // auto-center on GPS lock — but callable any time, not just once.
    MapView.centerOn(App.me.pos.x, App.me.pos.y, Math.max(MapView.zoom, 3), true);
  });

  const search = $("#map-search");
  search.addEventListener("input", async () => {
    const q = search.value.trim().toLowerCase();
    const box = $("#map-search-results");
    if (!q) { box.classList.remove("show"); box.innerHTML = ""; return; }
    const all = await Store.allUsers();
    const blocked = await Store.getBlocked(App.me.id);
    let candidates = all.filter((u) => u.id !== App.me.id && !blocked.includes(u.id));
    if (App.currentGroupId) {
      const group = await Store.getGroup(App.currentGroupId);
      const memberIds = group ? group.memberIds : [];
      candidates = candidates.filter((u) => memberIds.includes(u.id));
    } else {
      candidates = candidates.filter((u) => (u.mode || "everyone") === "everyone");
    }
    const results = candidates.filter((u) => isPinVisible(u) && u.name.toLowerCase().includes(q));
    box.innerHTML = results.length
      ? results.map((u) => `
        <div class="search-row" data-id="${u.id}">
          <div class="av" style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--line-soft);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:var(--ink-soft);">${avatarHTML(u)}</div>
          <div class="meta"><div class="n">${u.name}</div><div class="s">@${u.username}</div></div>
          <span class="active-dot"></span>
        </div>`).join("")
      : `<div style="padding:16px;text-align:center;color:var(--ink-faint);font-size:13px;">No active students found</div>`;
    box.classList.add("show");
    $all(".search-row").forEach((row) =>
      row.addEventListener("click", () => {
        jumpToUser(row.dataset.id);
        box.classList.remove("show");
        search.value = "";
      })
    );
  });

  // Closing on an outside tap now happens in MapView's own pointerdown
  // handler (see _wireGestures) — #info-backdrop is pointer-events:none
  // and purely decorative now, see the CSS comment on .info-card-backdrop.
}

async function jumpToUser(userId) {
  const all = await Store.allUsers();
  const u = all.find((x) => x.id === userId);
  if (!u) return;
  MapView.centerOn(u.pos.x, u.pos.y, Math.max(MapView.zoom, 2), true);
  App.highlightedPinId = userId;
  renderMapPins();
  setTimeout(() => { App.highlightedPinId = null; renderMapPins(); }, 4000);
}

/* ======================================================================
   MAP ZOOM / PAN ENGINE
   ----------------------------------------------------------------------
   Real pinch-to-zoom (2-finger) + drag-to-pan (1-finger) + wheel-zoom on
   the map ONLY, driven entirely by a CSS transform on #map-canvas. The
   browser's own page-zoom is disabled (see viewport meta tag + the
   touch-action rules in style.css), so pinching on the map can never
   zoom the rest of the app with it — that was the root cause of the
   "whole app gets zoomed" bug. Pins/labels/the info card counter-scale
   against the --zoom custom property this sets, so they stay a
   constant, readable size and correctly anchored at any zoom level.
   ====================================================================== */
const MapView = {
  zoom: 1,
  minZoom: 1,
  maxZoom: 8, // raised from 4 — was capping how far in you could zoom
  x: 0, // canvas translate in px (top-left of canvas relative to viewport)
  y: 0,
  baseW: 0, // canvas natural (zoom=1) size in px — computed to "cover" the viewport
  baseH: 0,
  el: null,
  scrollEl: null,

  init(canvasEl, scrollEl) {
    this.el = canvasEl;
    this.scrollEl = scrollEl;
    this._sizeCanvas();
    this._clampAndApply();
    this._wireGestures();
    window.addEventListener("resize", () => { this._sizeCanvas(); this._clampAndApply(); });
  },

  _sizeCanvas() {
    // Guard against sizing the canvas to (near) zero: #map-scroll reports
    // clientWidth/clientHeight of 0 whenever the map screen itself is
    // hidden (display:none, e.g. while you're on the Comments/Likes/
    // Profile tab). The old `|| 1` fallback let that 0 silently through as
    // a valid 1px viewport, which shrank the whole map canvas down to
    // ~1px — so switching back to the map showed nothing but the green
    // frame background behind the (now microscopic) map. This was most
    // reproducible after opening the keyboard on another tab (e.g. the
    // Comments search box), which fires a window "resize" event that used
    // to re-run this while the map was still hidden. Skipping the resize
    // entirely while hidden — and switchTab() forcing a fresh one when you
    // come back to "map" (see below) — fixes it at both ends.
    if (!this.scrollEl || this.scrollEl.clientWidth === 0 || this.scrollEl.clientHeight === 0) return;
    const vw = this.scrollEl.clientWidth;
    const vh = this.scrollEl.clientHeight;
    const aspect = (typeof CAMPUS_CONFIG !== "undefined" && CAMPUS_CONFIG.mapAspect) || (16 / 9);
    // "Cover" fit at zoom=1: base canvas always fully fills the viewport,
    // same idea as CSS background-size:cover, so there's never an empty
    // gap around the map no matter what shape the screen is.
    if (vw / vh > aspect) { this.baseW = vw; this.baseH = vw / aspect; }
    else { this.baseH = vh; this.baseW = vh * aspect; }
    this.el.style.width = this.baseW + "px";
    this.el.style.height = this.baseH + "px";
  },

  _clamp() {
    const vw = this.scrollEl.clientWidth;
    const vh = this.scrollEl.clientHeight;
    const w = this.baseW * this.zoom;
    const h = this.baseH * this.zoom;
    // Allow panning a little PAST the map image's true edges — a small
    // "frame" of extra space (rendered as green campus ground, see
    // .map-wrap's background in style.css) on every side. Without this,
    // a pin sitting right at the border of the map could only ever be
    // dragged as far as the image's literal edge, so reaching it meant
    // either leaving it pinned to the very corner of the screen or
    // zooming all the way out — this buffer means a small pan/zoom gets
    // it comfortably toward the center instead. Tripled per feedback (was
    // capped at 90px / 22% of viewport) for a noticeably roomier frame.
    // NOTE: this only changes how far the CAMERA can pan/where it clamps —
    // it has no effect on any user's actual coordinates. Pin positions
    // (user.pos.x/y), the campus geofence check, and everything stored in
    // the backend are all untouched; this is purely a viewport/rendering
    // concern in MapView.
    const frameX = Math.min(270, vw * 0.66);
    const frameY = Math.min(270, vh * 0.66);
    const minX = (vw - w) - frameX;
    const maxX = frameX;
    const minY = (vh - h) - frameY;
    const maxY = frameY;
    this.x = Math.min(maxX, Math.max(this.x, minX));
    this.y = Math.min(maxY, Math.max(this.y, minY));
  },

  _clampAndApply() {
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom));
    this._clamp();
    this.el.style.transform = `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.zoom})`;
    this.el.style.setProperty("--zoom", this.zoom);
    // Keep an open info-card correctly clamped as the map is zoomed/panned.
    // The card's edge-clamping correction (see positionInfoCard) is
    // computed in canvas-space using the zoom level AT THE MOMENT it's
    // calculated — if you then pinch/zoom while the card is open, that
    // frozen correction no longer matches the new scale and the card can
    // drift back out past the screen edge. Recomputing it every time the
    // canvas transform changes keeps it pinned inside the viewport at any
    // zoom level, not just the zoom level it happened to open at.
    const openCard = document.getElementById("active-info-card");
    if (openCard) repositionInfoCard(openCard);
  },

  /** Zoom by a factor, keeping the given viewport point (px, relative to
   *  #map-scroll) visually fixed under the fingers/cursor. */
  zoomAt(factor, px, py) {
    const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const actualFactor = newZoom / this.zoom;
    this.x = px - (px - this.x) * actualFactor;
    this.y = py - (py - this.y) * actualFactor;
    this.zoom = newZoom;
    this._clampAndApply();
  },

  panBy(dx, dy) {
    this.x += dx; this.y += dy;
    this._clampAndApply();
  },

  /** Smoothly center the view on a normalized (0..1, 0..1) map coordinate
   *  at the given zoom level. */
  centerOn(nx, ny, zoom, smooth) {
    if (this.stopMomentum) this.stopMomentum();
    const vw = this.scrollEl.clientWidth;
    const vh = this.scrollEl.clientHeight;
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    this.x = vw / 2 - nx * this.baseW * this.zoom;
    this.y = vh / 2 - ny * this.baseH * this.zoom;
    if (smooth) {
      this.el.style.transition = "transform .5s cubic-bezier(.2,.7,.3,1)";
      setTimeout(() => { this.el.style.transition = ""; }, 520);
    }
    this._clampAndApply();
  },

  _wireGestures() {
    const pointers = new Map(); // pointerId -> {x,y}
    let mode = null; // 'pan' | 'pinch'
    let panStart = null; // {x,y, mapX, mapY}
    let pinchStart = null; // {dist, zoom, midX, midY}
    // Tracks whether the current gesture has ever used 2+ fingers — set on
    // pinch-start, reset when a brand new gesture begins from zero fingers
    // down. Kept around for pan/pinch mode-switch bookkeeping in release().
    let gestureHadMultiTouch = false;

    // Momentum: track the last few pointer samples during a pan so we can
    // compute a release velocity and glide to a stop, instead of the map
    // just dead-stopping the instant a finger lifts — that dead-stop is
    // what reads as "stiff"/unresponsive compared to a real map app.
    let velSamples = []; // [{x,y,t}]
    let momentumRAF = null;

    const rectPoint = (e) => {
      const r = this.scrollEl.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    const stopMomentum = () => {
      if (momentumRAF) cancelAnimationFrame(momentumRAF);
      momentumRAF = null;
    };
    this.stopMomentum = stopMomentum;

    this.scrollEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".geo-banner")) return;
      if (e.target.closest(".info-card")) return; // let the card handle its own taps
      // Tapping anywhere else on the map (empty space or a different pin)
      // closes whatever card is currently open — replaces the old
      // backdrop-click-to-close, which broke because of the stacking
      // issue described in the CSS above. Harmless no-op if none is open.
      closeInfoCard();
      stopMomentum();
      if (pointers.size === 0) gestureHadMultiTouch = false;
      this.scrollEl.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, rectPoint(e));
      if (pointers.size === 1) {
        mode = "pan";
        const p = rectPoint(e);
        panStart = { x: p.x, y: p.y, mapX: this.x, mapY: this.y };
        velSamples = [{ x: p.x, y: p.y, t: performance.now() }];
      } else if (pointers.size === 2) {
        gestureHadMultiTouch = true;
        const [a, b] = [...pointers.values()];
        mode = "pinch";
        const m = mid(a, b);
        pinchStart = { dist: dist(a, b) || 1, zoom: this.zoom, mid: m };
      }
    });

    // Explicitly kill double-tap/double-click-to-zoom. Per feedback this
    // was making the map feel "chaotic" — an accidental fast double-tap
    // while trying to tap a pin or drag would suddenly jump the zoom
    // level. touch-action:none + the viewport meta tag (see index.html)
    // already stop most browsers from doing this natively, but some
    // mobile browsers/webviews still fire a native zoom on a fast double
    // tap regardless — this belt-and-braces listener suppresses that at
    // the event level too. There is no custom double-tap-zoom handler of
    // our own anywhere in this file; this only ever cancels the browser's.
    this.scrollEl.addEventListener("dblclick", (e) => e.preventDefault());

    // Coalesce pointermove -> transform updates to one per animation frame.
    // Applying the transform on every raw pointermove (which can fire far
    // faster than the screen refreshes) causes visible jank/stutter on
    // less powerful phones, which reads as the map "distorting" while
    // it's being panned/pinched. rAF-batching keeps it buttery smooth.
    let rafPending = false;
    const scheduleApply = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; this._clampAndApply(); });
    };

    this.scrollEl.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, rectPoint(e));
      if (mode === "pan" && pointers.size === 1 && panStart) {
        const p = [...pointers.values()][0];
        this.x = panStart.mapX + (p.x - panStart.x);
        this.y = panStart.mapY + (p.y - panStart.y);
        scheduleApply();

        // Keep a short rolling window of recent samples (~last 100ms) to
        // compute release velocity from, not just the single last frame —
        // a one-frame velocity is noisy and makes momentum feel erratic.
        const now = performance.now();
        velSamples.push({ x: p.x, y: p.y, t: now });
        while (velSamples.length > 6) velSamples.shift();
      } else if (mode === "pinch" && pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const d = dist(a, b) || 1;
        // Anchor on the CURRENT midpoint of the two fingers every frame,
        // not the midpoint captured at pinch-start. Anchoring on a stale
        // point meant that as soon as the person's fingers drifted while
        // pinching (which they always do a little), the map would slide
        // out from under their fingers instead of staying glued to them —
        // that mismatch between finger position and map movement is what
        // read as "distortion/stretching" during zoom.
        const m = mid(a, b);
        const rawFactor = d / pinchStart.dist;
        // Dampen how much zoom actually changes per unit of finger-distance
        // change — per feedback, zoom was way too sensitive/twitchy. Raising
        // the raw ratio to a fractional power keeps it a smooth, natural
        // pinch (small movement not doing nothing, huge movement not doing
        // everything) while needing a noticeably bigger pinch for the same
        // zoom change than before. Lower PINCH_SENSITIVITY = gentler.
        const PINCH_SENSITIVITY = 0.35;
        const factor = Math.pow(rawFactor, PINCH_SENSITIVITY);
        const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, pinchStart.zoom * factor));
        const actualFactor = newZoom / this.zoom;
        this.x = m.x - (m.x - this.x) * actualFactor;
        this.y = m.y - (m.y - this.y) * actualFactor;
        this.zoom = newZoom;
        scheduleApply();
      }
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 1) {
        // dropped from pinch back to a single finger — resume panning
        // smoothly from wherever that finger currently is.
        const p = [...pointers.values()][0];
        mode = "pan";
        panStart = { x: p.x, y: p.y, mapX: this.x, mapY: this.y };
        velSamples = [{ x: p.x, y: p.y, t: performance.now() }];
      } else if (pointers.size === 0) {
        // Compute release velocity (px/ms) from the recent sample window,
        // then glide with friction — a real "flick to scroll" feel
        // instead of the map just freezing the instant the finger lifts.
        if (mode === "pan" && velSamples.length >= 2) {
          const first = velSamples[0];
          const last = velSamples[velSamples.length - 1];
          const dt = last.t - first.t;
          if (dt > 0 && dt < 200) {
            let vx = (last.x - first.x) / dt;
            let vy = (last.y - first.y) / dt;
            const speed = Math.hypot(vx, vy);
            if (speed > 0.04) this._runMomentum(vx, vy);
          }
        }
        mode = null; panStart = null; pinchStart = null; velSamples = [];
      }
    };
    this.scrollEl.addEventListener("pointerup", release);
    this.scrollEl.addEventListener("pointercancel", release);

    this._runMomentum = (vx, vy) => {
      // px/ms velocity, decayed with friction each frame until it's
      // negligible or the map hits its pan bounds (clamping inside
      // _clampAndApply naturally kills momentum at the edge, which is
      // the correct/expected feel rather than bouncing past it).
      let lastT = performance.now();
      const friction = 0.94; // per-frame decay
      const step = (now) => {
        const dt = Math.min(32, now - lastT);
        lastT = now;
        this.x += vx * dt;
        this.y += vy * dt;
        vx *= Math.pow(friction, dt / 16);
        vy *= Math.pow(friction, dt / 16);
        this._clampAndApply();
        if (Math.hypot(vx, vy) > 0.01) {
          momentumRAF = requestAnimationFrame(step);
        } else {
          momentumRAF = null;
        }
      };
      momentumRAF = requestAnimationFrame(step);
    };

    // Desktop wheel zoom, centered on the cursor. Deliberately gentle and
    // normalized: raw wheel deltaY varies wildly between a mouse's notched
    // scroll (~100 per tick) and a trackpad's continuous fine-grained
    // scroll (~1-10 per event) — without normalizing, trackpad users would
    // barely zoom while a single mouse notch could jump multiple zoom
    // levels at once. Clamping the effective delta keeps every input
    // device zooming at the same, gentle, predictable rate. Sensitivity
    // dropped further per feedback (was 0.001, now a quarter of that) so
    // a single notch/scroll nudges the zoom instead of jumping it.
    this.scrollEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = rectPoint(e);
      const clampedDelta = Math.max(-24, Math.min(24, e.deltaY));
      const factor = 1 - clampedDelta * 0.00025;
      this.zoomAt(factor, p.x, p.y);
    }, { passive: false });
  },
};

let staleGpsWatchStarted = false;
/** Nobody pushes us an update the instant a pin goes stale — a device that
 *  simply stops sending fixes (backgrounded, killed, lost signal) never
 *  triggers a re-render on its own. So we re-check on a timer too, purely
 *  to age stale pins out; anything actually still live just keeps passing
 *  the PIN_STALE_MS check in renderMapPins() and stays put. */
function startStaleGpsWatch() {
  if (staleGpsWatchStarted) return;
  staleGpsWatchStarted = true;
  setInterval(() => {
    if (App.activeTab === "map") renderMapPins();
  }, 10000);
}

/** Single source of truth for "is this person's pin currently on the map" —
 *  used by renderMapPins() and by map search, so a user who's vanished
 *  from the map (GPS off, out of range, stale) can't turn up in search
 *  either. */
function isPinVisible(u) {
  return !!(u && u.pos && u.active && Date.now() - (u.lastSeen || 0) < PIN_STALE_MS);
}

async function renderMapPins() {
  if (!App.me) return; // not signed in / not ready yet — nothing to render
  const canvas = $("#map-canvas");
  const all = await Store.allUsers();
  const blocked = await Store.getBlocked(App.me.id);

  let visible = all.filter((u) => !blocked.includes(u.id));

  if (App.currentGroupId) {
    // A specific group's map — Friends only mode. Only that group's
    // members are ever shown here, regardless of anyone's Everyone/Friends
    // only toggle: being in the group is what grants visibility.
    const group = await Store.getGroup(App.currentGroupId);
    const memberIds = group ? group.memberIds : [App.me.id];
    visible = visible.filter((u) => memberIds.includes(u.id));
  } else {
    // The shared Everyone map. Anyone who has switched into Friends only
    // mode vanishes from here — their pin only shows up inside the maps of
    // the groups they belong to (see the branch above).
    visible = visible.filter((u) => u.id === App.me.id || (u.mode || "everyone") === "everyone");
  }
  // ensure "me" (latest live doc) is represented
  visible = visible.filter((u) => u.id !== App.me.id);
  visible.push(App.me);
  // Only show a pin once that person actually has a live position AND is
  // marked active — i.e. their GPS/location sharing is currently on — AND
  // that position isn't stale. "active" alone isn't enough: a device can
  // go dark (tab closed, GPS killed by the OS, network dropped) without
  // ever getting the chance to flip its own flag off, so we also age out
  // anyone whose last update is older than PIN_STALE_MS. Covers: they
  // turned location off, walked out of the map's range, or the app simply
  // lost track of whether their GPS is still on. (isPinVisible() is the
  // shared rule — search uses the same check so hidden pins can't be
  // found there either.)
  visible = visible.filter(isPinVisible);
  // Reuse existing pin elements keyed by user id instead of wiping and
  // rebuilding every pin on every update. Recreating the DOM node each
  // time discarded any in-flight CSS transition on left/top (see .pin in
  // style.css), so a moving pin never got to animate — it just snapped
  // straight to the new spot, which read as the map "blinking"/jittering
  // even though the position math itself was fine. Updating an existing
  // node's style instead lets that transition actually play, so
  // movement (including GPS updates) looks like a smooth glide.
  const existing = new Map();
  $all(".pin", canvas).forEach((p) => existing.set(p.dataset.id, p));
  const seen = new Set();

  visible.forEach((u) => {
    seen.add(u.id);
    const admin = isAdminEmail(u.email);
    const cls = "pin" + (u.id === App.me.id ? " me" : "") + (App.highlightedPinId === u.id ? " highlight" : "") + (admin ? " admin" : "");
    const left = u.pos.x * 100 + "%";
    const top = u.pos.y * 100 + "%";
    const inner = `<div class="pin-zoomfix"><div class="pin-body">${avatarHTML(u)}</div>${u.active ? '<div class="pulse"></div>' : ""}${admin ? '<div class="dev-tag">DEV</div>' : ""}</div>`;

    let pin = existing.get(u.id);
    if (pin) {
      // Same element as last render — only touch what actually changed,
      // so the browser can transition left/top smoothly.
      if (pin.className !== cls) pin.className = cls;
      if (pin.style.left !== left) pin.style.left = left;
      if (pin.style.top !== top) pin.style.top = top;
      if (pin._innerHTML !== inner) { pin.innerHTML = inner; pin._innerHTML = inner; }
    } else {
      pin = document.createElement("div");
      pin.className = cls;
      pin.style.left = left;
      pin.style.top = top;
      pin.dataset.id = u.id;
      pin.innerHTML = inner;
      pin._innerHTML = inner;
      pin.addEventListener("click", (e) => { e.stopPropagation(); openInfoCard(u); });
      canvas.appendChild(pin);
    }
  });

  // Remove pins for users no longer visible (went offline, got blocked,
  // filtered out by the Friends tab, etc.)
  existing.forEach((pin, id) => { if (!seen.has(id)) pin.remove(); });
}

async function openInfoCard(user) {
  closeInfoCard();
  App.openInfoCardFor = user.id;
  show($("#info-backdrop"));
  const card = document.createElement("div");
  card.className = "info-card";
  card.id = "active-info-card";
  // Store the pin's normalized map position (0..1) on the card itself —
  // positionInfoCard() reads this back together with the map's live
  // pan/zoom to work out real screen coordinates, every time the map
  // moves, rather than baking a position in once up front.
  card.dataset.mapX = user.pos.x;
  card.dataset.mapY = user.pos.y;

  // These are non-critical to *showing* the card — if either fails (a
  // transient Firestore hiccup, a missing index, etc.) fall back to safe
  // defaults instead of letting the whole card silently never render,
  // which is what made it look like the card + its buttons were broken.
  let blocked = false;
  let likedByMe = false;
  let isFriend = false;
  try {
    blocked = (await Store.getBlocked(App.me.id)).includes(user.id);
  } catch (err) { console.error("getBlocked failed:", err); }
  try {
    likedByMe = (await Store.getLikes()).some((l) => l.fromId === App.me.id && l.toId === user.id &&
      l.ts > Date.now() - 1000 * 60 * 60 * 24 * 3650); // "liked" state just reflects last like exists
  } catch (err) { console.error("getLikes failed:", err); }
  try {
    isFriend = (await Store.getFriends(App.me.id)).includes(user.id);
  } catch (err) { console.error("getFriends failed:", err); }

  card.innerHTML = `
    <div class="info-card-inner glass">
    <div class="head">
      <div class="av">${avatarHTML(user)}</div>
      <div>
        <div class="name">${user.name}</div>
        <div class="sub">@${user.username} · ${nearestRegion(user.pos)}</div>
      </div>
    </div>
    <div class="rows">
      <div class="r"><div class="k">Age</div><div class="v">${user.age || "—"}</div></div>
      <div class="r"><div class="k">Semester</div><div class="v">Sem ${user.semester || "—"}</div></div>
      <div class="r"><div class="k">Branch</div><div class="v">${(user.branch || "—").split(" - ").pop()}</div></div>
      <div class="r"><div class="k">Status</div><div class="v">${user.relationship || "—"}</div></div>
      <div class="r"><div class="k">Lives at</div><div class="v">${user.place || "—"}</div></div>
      <div class="r"><div class="k">Location</div><div class="v">${nearestRegion(user.pos)}</div></div>
    </div>
    ${user.id !== App.me.id ? `
    <div class="actions">
      <button class="profile-link">Profile</button>
      <button class="like-btn ${likedByMe ? "liked" : ""}">Like</button>
      <button class="comment-btn">Comment</button>
    </div>
    <button class="friend-link ${isFriend ? "added" : ""}">${isFriend ? "Friends" : "Add friend"}</button>
    <div class="comment-box" id="card-comment-box">
      <input id="card-comment-input" placeholder="Say something…" maxlength="140" />
      <button id="card-comment-send">Send</button>
    </div>
    <div class="comment-error" id="card-comment-error"></div>
    ` : `<div class="actions"><button class="profile-link">My profile page</button></div>`}
    </div>
  `;
  // Appended to .map-wrap (a plain, un-transformed sibling of #map-scroll)
  // rather than into #map-canvas — see the CSS comment on .info-card for
  // why living outside the zoomed/panned canvas is what makes this
  // reliably clampable at any zoom level.
  $(".map-wrap").appendChild(card);
  positionInfoCard(card);

  card.querySelector(".profile-link").addEventListener("click", () => {
    closeInfoCard();
    if (user.id === App.me.id) { switchTab("profile"); }
    else navigateToOtherProfile(user.id);
  });

  if (user.id !== App.me.id) {
    card.querySelector(".like-btn").addEventListener("click", async () => {
      try {
        await Store.addLike(App.me.id, user.id);
        spawnHeart(App.me.pos);
        card.querySelector(".like-btn").classList.add("liked");
        toast("Liked " + user.name.split(" ")[0]);
        refreshNavDots();
      } catch (err) {
        console.error("Like failed:", err);
        toast("Couldn't send that like — try again.");
      }
    });
    card.querySelector(".comment-btn").addEventListener("click", () => {
      card.querySelector("#card-comment-box").classList.add("show");
      card.querySelector("#card-comment-input").focus();
    });
    card.querySelector("#card-comment-send").addEventListener("click", () => submitCardComment(user, card));
    card.querySelector("#card-comment-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitCardComment(user, card);
    });
    card.querySelector(".friend-link").addEventListener("click", async (e) => {
      try {
        await Store.toggleFriend(App.me.id, user.id);
        const nowFriend = (await Store.getFriends(App.me.id)).includes(user.id);
        e.target.textContent = nowFriend ? "Friends" : "Add friend";
        e.target.classList.toggle("added", nowFriend);
        toast(nowFriend ? "Added " + user.name.split(" ")[0] + " as a friend" : "Removed from friends");
      } catch (err) {
        console.error("Toggle friend failed:", err);
        toast("Couldn't update friends — try again.");
      }
    });
  }
}

async function submitCardComment(user, card) {
  const input = card.querySelector("#card-comment-input");
  const text = input.value.trim();
  if (!text) return;
  const mod = moderateComment(text);
  const errEl = card.querySelector("#card-comment-error");
  if (!mod.allowed) {
    errEl.textContent = "That message isn't allowed.";
    errEl.classList.add("show");
    return;
  }
  errEl.classList.remove("show");
  try {
    await Store.addComment(App.me.id, user.id, mod.cleaned);
    spawnBubble(App.me, mod.cleaned);
    input.value = "";
    card.querySelector("#card-comment-box").classList.remove("show");
    toast("Comment sent");
    refreshNavDots();
  } catch (err) {
    console.error("Comment failed:", err);
    errEl.textContent = "Couldn't send — check your connection and try again.";
    errEl.classList.add("show");
  }
}

/** Position the info-card in real screen pixels and keep it fully inside
 *  the visible map viewport, at ANY zoom/pan state. The card lives outside
 *  #map-canvas (see openInfoCard), so — unlike the old approach of
 *  anchoring it inside the zoomed/panned canvas and trying to correct for
 *  that transform after the fact — its position here is computed straight
 *  from the pin's normalized map coordinate plus MapView's current
 *  x/y/zoom, every single call. That means it can never drift out of sync
 *  mid-gesture, which was the root cause of the card sliding partway off
 *  the screen (or under the bottom nav) when zoomed in near an edge.
 *  Called once when the card opens and again on every pan/zoom frame (see
 *  MapView._clampAndApply). */
function positionInfoCard(card) {
  const scrollEl = $("#map-scroll");
  if (!scrollEl) return;
  const nx = parseFloat(card.dataset.mapX);
  const ny = parseFloat(card.dataset.mapY);
  if (Number.isNaN(nx) || Number.isNaN(ny)) return;

  // Pin's current on-screen position, in plain pixels relative to
  // #map-scroll — this is exactly what the canvas's own CSS transform
  // (translate3d(x,y) scale(zoom)) would place it at.
  const pinX = MapView.x + nx * MapView.baseW * MapView.zoom;
  const pinY = MapView.y + ny * MapView.baseH * MapView.zoom;
  const gap = 14; // clearance between the card's bottom edge and the pin's tip

  const vw = scrollEl.clientWidth;
  const vh = scrollEl.clientHeight;
  const cardW = card.offsetWidth || 250;
  const cardH = card.offsetHeight || 260;
  const pad = 12;
  // The floating topbar+search bar and the floating bottom nav both sit ON
  // TOP of #map-scroll (absolutely positioned over it, not in its flow),
  // so the card needs real reserved space at both ends — not just the
  // container's literal edges — or it slides underneath them. Bumped up
  // slightly to match the larger gaps now reserved above the search bar
  // and below the bottom nav.
  const topSafeZone = 128;
  const bottomSafeZone = 112;

  let left = pinX;
  let top = pinY - gap;

  const halfW = cardW / 2;
  const minLeft = pad + halfW;
  const maxLeft = Math.max(minLeft, vw - pad - halfW);
  left = Math.min(maxLeft, Math.max(minLeft, left));

  const minTop = topSafeZone + cardH;
  const maxTop = Math.max(minTop, vh - bottomSafeZone);
  top = Math.min(maxTop, Math.max(minTop, top));

  card.style.left = left + "px";
  card.style.top = top + "px";
}

/** Thin wrapper so MapView (which doesn't know about info-card internals)
 *  can just say "reposition whatever's open" on every transform change. */
function repositionInfoCard(card) {
  positionInfoCard(card);
}

function closeInfoCard() {
  const existing = $("#active-info-card");
  if (existing) existing.remove();
  hide($("#info-backdrop"));
  App.openInfoCardFor = null;
}

/* ---- floating comment tile, anchored on the map at the commenter's pin.
   Only ever shows ONE tile per sender: a fresh comment from the same
   person within the 10s window replaces (not stacks under) the previous
   one and restarts the 10s timer, per spec. ---- */
function spawnBubble(fromUser, text) {
  const canvas = $("#map-canvas");
  const key = fromUser.id;
  clearTimeout(App.bubbleTimers[key]);

  const wrapId = "bubble-wrap-" + key;
  let wrap = document.getElementById(wrapId);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = wrapId;
    wrap.className = "bubble-wrap";
    wrap.style.position = "absolute";
    wrap.style.left = fromUser.pos.x * 100 + "%";
    wrap.style.top = "calc(" + fromUser.pos.y * 100 + "% - 48px)";
    canvas.appendChild(wrap);
  } else {
    wrap.style.left = fromUser.pos.x * 100 + "%";
    wrap.style.top = "calc(" + fromUser.pos.y * 100 + "% - 48px)";
  }
  wrap.innerHTML = `<div class="floating-bubble glass-dark"><div class="who">${fromUser.name.split(" ")[0]}</div>${text}</div>`;
  playNotifySound();
  App.bubbleTimers[key] = setTimeout(() => wrap.remove(), 10000);
}

/* Short synthesized "pop" — no audio file to ship/host, works the instant
   the tab has had any user interaction (required before autoplay is
   allowed; by the time comments can arrive the person has already tapped
   into the app, so this reliably has permission). */
let _audioCtx = null;
function playNotifySound() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch (e) { /* audio not available (autoplay-blocked, unsupported) — fail silently */ }
}

function spawnHeart(fromPos) {
  const canvas = $("#map-canvas");
  const h = document.createElement("div");
  h.className = "heart-pop";
  h.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.9-10.2-9.3C.1 8.7 1.4 5 5 4.2c2.1-.5 4 .5 5 2.3 1-1.8 2.9-2.8 5-2.3 3.6.8 4.9 4.5 3.2 7.5C19.5 16.1 12 21 12 21z"/></svg>';
  h.style.color = "var(--rose, #d1495b)";
  h.style.left = fromPos.x * 100 + "%";
  h.style.top = fromPos.y * 100 + "%";
  canvas.appendChild(h);
  playNotifySound();
  setTimeout(() => h.remove(), 1800);
}

/** Single entry point for "someone commented/liked me" — used by both the
 *  live realtime subscription and the local-demo simulator. If the map is
 *  on screen right now, show it immediately next to their pin like before;
 *  otherwise queue it instead of silently dropping it, so switching to the
 *  map afterwards still shows what happened while you were away. */
function showOrQueueActivity(kind, actor, text) {
  if (App.activeTab === "map") {
    if (kind === "comment") spawnBubble(actor, text);
    else { spawnHeart(actor.pos); playNotifySound(); }
  } else {
    App.pendingMapActivity.push({ kind, actorId: actor.id, text });
  }
}

/** Replays anything queued by showOrQueueActivity() while the map wasn't
 *  visible — called whenever the map screen actually comes on screen (see
 *  switchTab()). Re-looks-up each actor's CURRENT pin position rather than
 *  trusting a possibly-stale one captured back when the event happened,
 *  and staggers multiple bubbles/hearts slightly so a burst of activity
 *  doesn't all land on top of itself in the same instant. */
async function flushPendingMapActivity() {
  if (!App.pendingMapActivity.length) return;
  const queued = App.pendingMapActivity.splice(0, App.pendingMapActivity.length);
  const all = await Store.allUsers();
  queued.forEach((item, i) => {
    const actor = all.find((u) => u.id === item.actorId);
    if (!actor || !actor.pos) return;
    setTimeout(() => {
      if (item.kind === "comment") spawnBubble(actor, item.text);
      else { spawnHeart(actor.pos); playNotifySound(); }
    }, i * 500);
  });
}

/* ---- background "activity" simulation: demo classmates occasionally
   comment/like the current user, so the live features are visible without
   needing a second real device. In production this comes from a realtime
   backend subscription instead of a client-side timer. ---- */
function startActivitySimulation() {
  if (App.simTimer) clearInterval(App.simTimer);
  App.simTimer = setInterval(async () => {
    if (App.activeTab !== "map" && Math.random() > 0.5) return;
    const all = await Store.allUsers();
    const others = all.filter((u) => u.id !== App.me.id);
    if (!others.length) return;
    const actor = others[Math.floor(Math.random() * others.length)];
    const sampleLines = [
      "hey! saw you near the lawn", "what's up!", "library later?",
      "nice fit today", "nice to see you here", "class at 2?", "come to the canteen",
    ];
    if (Math.random() > 0.5) {
      const text = sampleLines[Math.floor(Math.random() * sampleLines.length)];
      await Store.addComment(actor.id, App.me.id, text);
      showOrQueueActivity("comment", actor, text);
    } else {
      await Store.addLike(actor.id, App.me.id);
      showOrQueueActivity("like", actor);
    }
    refreshNavDots();
  }, 28000);
}

/* ======================================================================
   BOTTOM NAV
   ====================================================================== */
function wireBottomNav() {
  $all("#bottom-nav button").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
  // Keep the sliding glass pill lined up with the active tab even if the
  // bar's width changes (rotation, resize) while it's on screen.
  window.addEventListener("resize", () => moveNavPill());
}
/** Positions the little glass "pill" behind whichever tab button is
 *  currently .active, measuring the real button so it always lines up
 *  exactly regardless of icon width/spacing — see .nav-active-pill in
 *  css/style.css for what actually renders it. */
function moveNavPill() {
  const nav = $("#bottom-nav");
  const btn = nav.querySelector("button.active");
  const pill = $("#nav-active-pill");
  if (!nav || !btn || !pill) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  // Perfect circle: diameter is capped to fit inside the bar's height
  // (minus a little breathing room) and the button's own width, then
  // centered on the button. Using one shared value for both width and
  // height (see .nav-active-pill) is what keeps it a circle instead of
  // an oval/rounded-rect as the bar height or button width changes.
  const diameter = Math.min(navRect.height - 8, btnRect.width);
  const btnCenterX = btnRect.left + btnRect.width / 2 - navRect.left;
  nav.style.setProperty("--pill-x", btnCenterX - diameter / 2 + "px");
  nav.style.setProperty("--pill-w", diameter + "px");
}
async function switchTab(tab) {
  App.activeTab = tab;
  $all("#bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "map") {
    if (App.scope === "friends") {
      // The Map tab means "wherever this mode's map lives" — for Friends
      // only mode that's the groups list, not a group's map, even if one
      // happened to be open before switching tabs away.
      App.currentGroupId = null;
      hideGroupMapChrome();
      goTo("screen-groups");
      renderGroupsList();
    } else {
      goTo("screen-map");
      // Force a fresh size/clamp on every return to the map, not just
      // renderMapPins() — self-heals even if something odd happened to
      // MapView's dimensions while this tab was hidden (see the guard in
      // _sizeCanvas for the actual root-cause fix).
      if (MapView.el) { MapView._sizeCanvas(); MapView._clampAndApply(); }
      renderMapPins();
      flushPendingMapActivity();
    }
  } else {
    goTo("screen-" + tab); // also repositions the active-tab glass pill, see goTo()
  }
  if (tab === "comments") { await Store.markTabSeen("comments"); renderCommentsList(); }
  if (tab === "likes") { await Store.markTabSeen("likes"); renderLikesList(); }
  if (tab === "profile") renderMyProfile();
  refreshNavDots();
}
async function refreshNavDots() {
  const seen = await Store.getUnseenTabs();
  $("#dot-comments").classList.toggle("show", !seen.comments);
  $("#dot-likes").classList.toggle("show", !seen.likes);
}

/* ======================================================================
   COMMENTS TAB
   ====================================================================== */
function wireCommentsTab() {
  const search = $("#comments-search");
  search.addEventListener("input", () => genericThreadSearch(search, "comments", "comments-search-results"));
  $("#comments-clear").addEventListener("click", () => { App.commentThreadUser = null; renderCommentsList(); });
  $("#comments-prev").addEventListener("click", () => stepThread("comments", -1));
  $("#comments-next").addEventListener("click", () => stepThread("comments", 1));
}
function wireLikesTab() {
  const search = $("#likes-search");
  search.addEventListener("input", () => genericThreadSearch(search, "likes", "likes-search-results"));
  $("#likes-clear").addEventListener("click", () => { App.likeThreadUser = null; renderLikesList(); });
  $("#likes-prev").addEventListener("click", () => stepThread("likes", -1));
  $("#likes-next").addEventListener("click", () => stepThread("likes", 1));
}

async function genericThreadSearch(input, kind, resultsBoxId) {
  const q = input.value.trim().toLowerCase();
  const box = $("#" + resultsBoxId);
  if (!q) { box.classList.remove("show"); return; }
  const all = await Store.allUsers();
  const results = all.filter((u) => u.id !== App.me.id && u.name.toLowerCase().includes(q));
  box.innerHTML = results.length
    ? results.map((u) => `
      <div class="search-row" data-id="${u.id}">
        <div class="av" style="width:34px;height:34px;border-radius:50%;overflow:hidden;background:var(--line-soft);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:var(--ink-soft);">${avatarHTML(u)}</div>
        <div class="meta"><div class="n">${u.name}</div><div class="s">@${u.username}</div></div>
        ${u.active ? '<span class="active-dot"></span>' : ""}
      </div>`).join("")
    : `<div style="padding:16px;text-align:center;color:var(--ink-faint);font-size:13px;">No students found</div>`;
  box.classList.add("show");
  $all("#" + resultsBoxId + " .search-row").forEach((row) =>
    row.addEventListener("click", () => {
      if (kind === "comments") { App.commentThreadUser = row.dataset.id; renderCommentsList(true); }
      else { App.likeThreadUser = row.dataset.id; renderLikesList(true); }
      box.classList.remove("show");
      input.value = "";
    })
  );
}

async function stepThread(kind, dir) {
  const rows = $all(".activity-row[data-ts]", $("#" + kind + "-list"));
  if (!rows.length) return;
  let idx = rows.findIndex((r) => r.classList.contains("highlight"));
  idx = idx === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + dir));
  rows.forEach((r) => r.classList.remove("highlight"));
  rows[idx].classList.add("highlight");
  rows[idx].scrollIntoView({ block: "center", behavior: "smooth" });
}

async function renderCommentsList(jumpToLatest) {
  const all = await Store.allUsers();
  const usersById = Object.fromEntries(all.map((u) => [u.id, u]));
  const blocked = await Store.getBlocked(App.me.id);
  let comments = (await Store.getComments()).filter(
    (c) => (c.fromId === App.me.id || c.toId === App.me.id) && !blocked.includes(c.fromId) && !blocked.includes(c.toId)
  );
  if (App.commentThreadUser) {
    comments = comments.filter((c) => c.fromId === App.commentThreadUser || c.toId === App.commentThreadUser);
    $("#comments-user-nav").style.display = "flex";
    $("#comments-who").textContent = usersById[App.commentThreadUser]?.name || "";
  } else {
    $("#comments-user-nav").style.display = "none";
  }

  renderActivityList("#comments-list", comments, usersById, "comment");
  renderScrubber("#comments-scrubber", comments);
  if (jumpToLatest) setTimeout(() => stepThread("comments", 0), 50);
}

async function renderLikesList(jumpToLatest) {
  const all = await Store.allUsers();
  const usersById = Object.fromEntries(all.map((u) => [u.id, u]));
  const blocked = await Store.getBlocked(App.me.id);
  let likes = (await Store.getLikes()).filter(
    (l) => (l.fromId === App.me.id || l.toId === App.me.id) && !blocked.includes(l.fromId) && !blocked.includes(l.toId)
  );
  if (App.likeThreadUser) {
    likes = likes.filter((l) => l.fromId === App.likeThreadUser || l.toId === App.likeThreadUser);
    $("#likes-user-nav").style.display = "flex";
    $("#likes-who").textContent = usersById[App.likeThreadUser]?.name || "";
  } else {
    $("#likes-user-nav").style.display = "none";
  }

  renderActivityList("#likes-list", likes, usersById, "like");
  renderScrubber("#likes-scrubber", likes);
  if (jumpToLatest) setTimeout(() => stepThread("likes", 0), 50);
}

function renderActivityList(containerSel, items, usersById, kind) {
  const container = $(containerSel);
  if (!items.length) {
    const icon = kind === "comment"
      ? '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>'
      : '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/></svg>';
    container.innerHTML = `<div class="empty-state"><div class="e">${icon}</div>No ${kind}s yet.</div>`;
    return;
  }
  let lastMonth = null;
  let html = "";
  items.forEach((item) => {
    const month = fmtMonth(item.ts);
    if (month !== lastMonth) { html += `<div class="month-divider">${month}</div>`; lastMonth = month; }
    const other = usersById[item.fromId === App.me.id ? item.toId : item.fromId];
    if (!other) return;
    const mine = item.fromId === App.me.id;
    const label = kind === "comment"
      ? (mine ? `You: ${item.text}` : item.text)
      : (mine ? "You liked their pin" : "Liked your pin");
    html += `
      <div class="activity-row" data-ts="${item.ts}" data-id="${item.id}" data-user-id="${other.id}" style="cursor:pointer;">
        <div class="av">${avatarHTML(other)}</div>
        <div class="body">
          <div class="top"><span class="name">${other.name}</span><span class="time">${timeAgo(item.ts)} · ${fmtDate(item.ts)}</span></div>
          <div class="text ${kind === "like" ? "like" : ""}">${label}</div>
        </div>
      </div>`;
  });
  container.innerHTML = html;
  // Tapping anywhere on a row (not just the avatar) opens that person's
  // full profile — same profile screen the map pin's info card links to.
  $all(".activity-row", container).forEach((row) =>
    row.addEventListener("click", () => navigateToOtherProfile(row.dataset.userId))
  );
}

function renderScrubber(sel, items) {
  const el = $(sel);
  if (!items.length) { el.innerHTML = ""; return; }
  const months = [...new Set(items.map((i) => fmtMonth(i.ts)))];
  el.innerHTML = months.map((m, i) => `<div class="tick${i === 0 ? " current" : ""}">${m.split(" ")[0]}</div>`).join("");
}

/* ======================================================================
   PROFILE TABS
   ====================================================================== */
function wireProfileTab() {
  $("#btn-logout").addEventListener("click", async () => {
    await Auth.signOut();
    Geo.stop(); Geo.stopDemoWalk();
    location.reload();
  });
  $("#btn-edit-profile").addEventListener("click", openEditProfileModal);
  $("#btn-blocked-list").addEventListener("click", openBlockedModal);
}

function profileInfoGrid(u) {
  return `
    <div class="cell"><div class="k">Age</div><div class="v">${u.age || "—"}</div></div>
    <div class="cell"><div class="k">Semester</div><div class="v">Semester ${u.semester || "—"}</div></div>
    <div class="cell" style="grid-column: span 2;"><div class="k">Branch</div><div class="v">${u.branch || "—"}</div></div>
    <div class="cell"><div class="k">Status</div><div class="v">${u.relationship || "—"}</div></div>
    <div class="cell"><div class="k">Lives at</div><div class="v">${u.place || "—"}</div></div>
    ${u.phone ? `<div class="cell"><div class="k">Contact</div><div class="v">${u.phone}</div></div>` : ""}
    ${u.social ? `<div class="cell"><div class="k">Social</div><div class="v">${u.social}</div></div>` : ""}
  `;
}

async function renderMyProfile() {
  const u = App.me;
  $("#my-profile-av").innerHTML = avatarHTML(u);
  $("#my-profile-name").textContent = u.name;
  $("#my-profile-uname").textContent = "@" + u.username;
  $("#my-profile-enroll").textContent = u.email;
  $("#my-profile-grid").innerHTML = profileInfoGrid(u);
  const blocked = await Store.getBlocked(u.id);
  $("#blocked-count-sub").textContent = blocked.length ? `${blocked.length} user(s) blocked` : "Manage who can't see or contact you";
}

/* ---- edit profile modal reuses the onboarding fields, inline ---- */
function openEditProfileModal() {
  const u = App.me;
  $("#edit-modal-body").innerHTML = `
    <div class="avatar-upload">
      <div class="circle" id="edit-avatar-circle">${u.photo ? `<img src="${u.photo}"/>` : '<span class="plus">+</span>'}</div>
      <input type="file" id="edit-avatar-input" accept="image/*" hidden />
      <div class="label">Change photo</div>
    </div>
    <div class="field"><label>Full name</label><input id="edit-name" value="${u.name}" /></div>
    <div class="field"><label>Username</label><input id="edit-username" value="${u.username}" /></div>
    <div class="field"><label>Age</label><input id="edit-age" type="number" value="${u.age}" /></div>
    <div class="field"><label>Branch</label><select id="edit-branch">${BRANCHES.map((b) => `<option ${b === u.branch ? "selected" : ""}>${b}</option>`).join("")}</select></div>
    <div class="field"><label>Semester</label><select id="edit-semester">${[1,2,3,4,5,6,7,8].map((s) => `<option value="${s}" ${s === u.semester ? "selected" : ""}>Semester ${s}</option>`).join("")}</select></div>
    <div class="field"><label>Where you live</label>
      <div class="pill-toggle" id="edit-toggle-place">
        <button data-val="hostel" class="${u.placeType === "hostel" ? "selected" : ""}">Campus hostel</button>
        <button data-val="city" class="${u.placeType === "city" ? "selected" : ""}">Select city</button>
      </div>
      <input id="edit-place-detail" style="margin-top:10px;" value="${u.place || ""}" />
    </div>
    <div class="field"><label>Relationship status</label>
      <div class="pill-toggle" id="edit-toggle-relationship">
        <button data-val="Single" class="${u.relationship === "Single" ? "selected" : ""}">Single</button>
        <button data-val="Taken" class="${u.relationship === "Taken" ? "selected" : ""}">Taken</button>
      </div>
    </div>
    <div class="field"><label>Contact number</label><input id="edit-phone" value="${u.phone || ""}" /></div>
    <div class="field"><label>Social handle</label><input id="edit-social" value="${u.social || ""}" /></div>
    <button class="btn-primary" id="edit-save-btn">Save changes</button>
  `;
  let newPhoto = u.photo;
  $("#edit-avatar-circle").addEventListener("click", () => $("#edit-avatar-input").click());
  $("#edit-avatar-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Please choose an image file"); return; }
    const prevHTML = $("#edit-avatar-circle").innerHTML;
    $("#edit-avatar-circle").innerHTML = `<span class="plus">…</span>`;
    try {
      newPhoto = await resizeImageFile(file);
      $("#edit-avatar-circle").innerHTML = `<img src="${newPhoto}"/>`;
    } catch (err) {
      console.error("Avatar resize failed:", err);
      toast("Couldn't use that photo — try a different one");
      $("#edit-avatar-circle").innerHTML = prevHTML;
    }
  });
  $all("#edit-toggle-place button").forEach((b) => b.addEventListener("click", () => setPill("#edit-toggle-place", b.dataset.val)));
  $all("#edit-toggle-relationship button").forEach((b) => b.addEventListener("click", () => setPill("#edit-toggle-relationship", b.dataset.val)));

  const saveBtn = $("#edit-save-btn");
  saveBtn.addEventListener("click", async () => {
    // Guard against double-submits (double-tap on mobile is what most often
    // made this look "broken" — the second click fired before the first
    // write finished, throwing an unhandled rejection that silently ate
    // the whole save).
    if (saveBtn.disabled) return;

    const name = $("#edit-name").value.trim();
    const uname = $("#edit-username").value.trim();
    if (!name) { toast("Please enter your name"); return; }
    if (!uname) { toast("Please enter a username"); return; }

    const originalLabel = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
      const taken = await Store.isUsernameTaken(uname, u.id);
      if (taken) { toast("That username is taken"); return; }

      // Work on a copy so a failed/aborted save never corrupts App.me —
      // previously a mid-save failure (e.g. the photo upload rejecting)
      // could leave App.me half-updated while nothing was persisted.
      const next = { ...u };
      next.photo = newPhoto;
      next.name = name;
      next.username = uname;
      next.age = Number($("#edit-age").value) || "";
      next.branch = $("#edit-branch").value;
      next.semester = Number($("#edit-semester").value);
      next.placeType = $("#edit-toggle-place button.selected")?.dataset.val;
      next.place = $("#edit-place-detail").value.trim();
      next.relationship = $("#edit-toggle-relationship button.selected")?.dataset.val;
      next.phone = $("#edit-phone").value.trim();
      next.social = $("#edit-social").value.trim();

      const saved = await Store.saveUser(next);
      App.me = saved || next;
      closeModal("edit");
      renderMyProfile();
      renderMapPins();
      toast("Profile updated");
    } catch (err) {
      console.error("Profile save failed:", err);
      // Surface *why* it failed instead of doing nothing — this is the
      // actual bug: saves that errored out (offline, permission issue,
      // photo upload failure) used to fail completely silently.
      const code = err && err.code || "";
      const msg = code === "permission-denied"
        ? "Couldn't save — you don't have permission to update this profile."
        : code.startsWith("storage/")
        ? "Couldn't upload your photo (" + code.replace("storage/", "") + "). Try a smaller image or a different one."
        : !navigator.onLine
        ? "You're offline — connect to the internet and try again."
        : "Couldn't save your changes: " + (err && err.message ? err.message : "unknown error") + ".";
      toast(msg);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  });
  openModal("edit");
}

async function openBlockedModal() {
  // Snapshot the token before the awaited fetches below. If modal state
  // changes (another modal opens/closes, or navigation happens) while
  // we're waiting on the network, modalToken will have moved on and we
  // skip the stale openModal("blocked") call at the end.
  const myModalToken = modalToken;
  const blockedIds = await Store.getBlocked(App.me.id);
  const all = await Store.allUsers();
  if (myModalToken !== modalToken) return; // stale — something else changed modal state meanwhile
  const list = all.filter((u) => blockedIds.includes(u.id));
  $("#blocked-list").innerHTML = list.length
    ? list.map((u) => `
      <div class="block-list-item">
        <div class="av">${avatarHTML(u)}</div>
        <div class="name">${u.name}</div>
        <button data-id="${u.id}">Unblock</button>
      </div>`).join("")
    : `<div class="empty-state"><div class="e"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></div>No blocked users.</div>`;
  $all("#blocked-list button").forEach((b) =>
    b.addEventListener("click", async () => {
      await Store.toggleBlock(App.me.id, b.dataset.id);
      openBlockedModal();
      renderMapPins();
      toast("Unblocked");
    })
  );
  openModal("blocked");
}

/* ======================================================================
   OTHER USER PROFILE
   ====================================================================== */
// Where the Back button (and the phone's own back button/gesture) should
// return to after viewing someone's profile — set the moment we navigate
// IN, so "back" always lands wherever the person actually came from
// (map / a specific comments thread / a specific likes thread) instead of
// unconditionally jumping to the map.
let profileReturnTo = null;

function wireOtherProfile() {
  $("#btn-back-from-profile").addEventListener("click", () => {
    // Just ask the browser to go back — the popstate listener below (set
    // up wherever navigateToOtherProfile() pushed a history entry) is the
    // single place that actually restores the previous screen, so the
    // in-app Back button and the phone/browser's own back button behave
    // identically instead of the button doing something different.
    if (history.state && history.state.ccScreen === "other-profile") history.back();
    else returnFromOtherProfile(); // no history entry (shouldn't normally happen) — restore directly
  });
  window.addEventListener("popstate", () => {
    if ($("#screen-other-profile").classList.contains("active")) returnFromOtherProfile();
  });
}

/** Entry point for actually navigating TO a profile (tapping a pin's info
 *  card, a comment/like row, etc.) — captures exactly where we're coming
 *  from and pushes a history entry so the back button has something to
 *  pop. Internal same-screen refreshes (after adding a friend / blocking)
 *  call openOtherProfile() directly instead, since those aren't really
 *  "navigating" anywhere new. */
function navigateToOtherProfile(userId) {
  const onList = App.activeTab === "comments" || App.activeTab === "likes";
  profileReturnTo = {
    tab: App.activeTab,
    threadUser: App.activeTab === "comments" ? App.commentThreadUser : App.activeTab === "likes" ? App.likeThreadUser : null,
    scrollY: onList ? ($("#" + App.activeTab + "-list-wrap")?.scrollTop || 0) : 0,
  };
  history.pushState({ ccScreen: "other-profile" }, "", "");
  openOtherProfile(userId);
}

function returnFromOtherProfile() {
  const ret = profileReturnTo || { tab: "map" };
  profileReturnTo = null;
  if (ret.tab === "comments") App.commentThreadUser = ret.threadUser;
  if (ret.tab === "likes") App.likeThreadUser = ret.threadUser;
  switchTab(ret.tab);
  if (ret.scrollY) {
    // Restore scroll after the list has actually re-rendered — right after
    // switchTab() the wrap is still empty for a beat while renderCommentsList/
    // renderLikesList (both async) finish filling it back in.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const wrap = $("#" + ret.tab + "-list-wrap");
      if (wrap) wrap.scrollTop = ret.scrollY;
    }));
  }
}

async function openOtherProfile(userId) {
  const all = await Store.allUsers();
  const u = all.find((x) => x.id === userId);
  if (!u) return;
  $("#op-av").innerHTML = avatarHTML(u);
  $("#op-name").textContent = u.name;
  $("#op-uname").textContent = "@" + u.username;
  $("#op-enroll").textContent = u.email;
  $("#op-grid").innerHTML = profileInfoGrid(u);

  const friends = await Store.getFriends(App.me.id);
  const isFriend = friends.includes(u.id);
  const friendBtn = $("#op-friend-btn");
  friendBtn.textContent = isFriend ? "Friends" : "+ Add friend";
  friendBtn.onclick = async () => {
    await Store.toggleFriend(App.me.id, u.id);
    openOtherProfile(u.id);
  };

  const blocked = await Store.getBlocked(App.me.id);
  const isBlocked = blocked.includes(u.id);
  const blockBtn = $("#op-block-btn");
  blockBtn.textContent = isBlocked ? "Unblock" : "Block";
  blockBtn.onclick = async () => {
    await Store.toggleBlock(App.me.id, u.id);
    openOtherProfile(u.id);
    renderMapPins();
  };

  goTo("screen-other-profile");
}

/* ======================================================================
   MODALS
   ====================================================================== */
function wireModals() {
  $("#edit-modal-close").addEventListener("click", () => closeModal("edit"));
  $("#edit-modal-backdrop").addEventListener("click", () => closeModal("edit"));
  $("#blocked-modal-close").addEventListener("click", () => closeModal("blocked"));
  $("#blocked-modal-backdrop").addEventListener("click", () => closeModal("blocked"));
  $("#creategroup-modal-close").addEventListener("click", () => closeModal("creategroup"));
  $("#creategroup-modal-backdrop").addEventListener("click", () => closeModal("creategroup"));
  $("#invite-modal-close").addEventListener("click", () => closeModal("invite"));
  $("#invite-modal-backdrop").addEventListener("click", () => closeModal("invite"));
  $("#inbox-modal-close").addEventListener("click", () => closeModal("inbox"));
  $("#inbox-modal-backdrop").addEventListener("click", () => closeModal("inbox"));
  $("#invite-search").addEventListener("input", () => renderInviteList(App._inviteModalGroupId));
}
// Bumped on every modal state change (open/close/close-all). Async modal
// openers (openBlockedModal/openInviteModal/openInboxModal) capture this
// value before their awaited fetches and re-check it afterwards, so a
// slow, now-stale fetch can't yank an old modal back open on top of
// whatever the user has since navigated to or opened instead.
let modalToken = 0;
function openModal(name) {
  // Only one modal sheet should ever be visible at once — opening a new
  // one first closes anything left open (see closeAllModals()'s doc
  // comment for why a stray one can otherwise linger).
  closeAllModals();
  modalToken++;
  show($("#" + name + "-modal-backdrop"));
  show($("#" + name + "-modal"));
}
function closeModal(name) { modalToken++; hide($("#" + name + "-modal-backdrop")); hide($("#" + name + "-modal")); }
function closeAllModals() {
  modalToken++;
  $all(".modal-sheet.show").forEach((el) => el.classList.remove("show"));
  $all(".modal-backdrop.show").forEach((el) => el.classList.remove("show"));
}

/* ======================================================================
   GROUPS — Friends only mode
   ====================================================================== */
function wireGroups() {
  $("#btn-new-group").addEventListener("click", openCreateGroupModal);
  $("#btn-inbox").addEventListener("click", openInboxModal);

  $("#btn-create-group-submit").addEventListener("click", async () => {
    const nameInput = $("#input-group-name");
    const name = nameInput.value.trim();
    if (!name) { toast("Give your group a name"); return; }
    const btn = $("#btn-create-group-submit");
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const group = await Store.createGroup(App.me.id, name);
      nameInput.value = "";
      closeModal("creategroup");
      renderGroupsList();
      toast("Group created");
      // Straight into inviting people — creating an empty group on its own
      // isn't useful, so the natural next step is offered immediately.
      openInviteModal(group.id);
    } catch (err) {
      console.error("Create group failed:", err);
      toast("Couldn't create that group — try again.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Create group";
    }
  });
}

async function openCreateGroupModal() {
  $("#input-group-name").value = "";
  openModal("creategroup");
  $("#input-group-name").focus();
}

async function renderGroupsList() {
  if (!App.me) return;
  const groups = await Store.getMyGroups(App.me.id);
  const wrap = $("#groups-list");
  if (!groups.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="e"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.6"/><path d="M15.3 14.3c2.6.3 4.6 2.4 5.2 5.7"/></svg></div>No groups yet. Create one to share your location with just your friends.</div>`;
    return;
  }
  wrap.innerHTML = groups.map((g) => `
    <div class="group-row" data-id="${g.id}">
      <div class="group-av">${initials(g.name)}</div>
      <div class="meta"><div class="n">${g.name}</div><div class="s">${g.memberIds.length} member${g.memberIds.length === 1 ? "" : "s"}</div></div>
      <button class="row-invite-btn" data-id="${g.id}">Invite</button>
    </div>`).join("");
  $all(".group-row", wrap).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".row-invite-btn")) return;
      openGroupMap(row.dataset.id);
    });
  });
  $all(".row-invite-btn", wrap).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openInviteModal(btn.dataset.id);
    });
  });
}

/** Generic "invite people to this group" modal — used both right after
 *  creating a group and from a group row's Invite button. Anyone signed
 *  into the app can be invited, per spec; sending is immediate per row
 *  (no separate confirm step) and the row flips to "Invited" right away. */
async function openInviteModal(groupId) {
  // Same stale-response guard as openBlockedModal — see its comment.
  const myModalToken = modalToken;
  App._inviteModalGroupId = groupId;
  const group = await Store.getGroup(groupId);
  $("#invite-modal-title").textContent = group ? `Invite to ${group.name}` : "Invite people";
  $("#invite-search").value = "";
  await renderInviteList(groupId);
  if (myModalToken !== modalToken) return; // stale — something else changed modal state meanwhile
  openModal("invite");
}

async function renderInviteList(groupId) {
  if (!groupId) return;
  const q = $("#invite-search").value.trim().toLowerCase();
  const group = await Store.getGroup(groupId);
  const memberIds = group ? group.memberIds : [];
  const all = (await Store.allUsers()).filter(
    (u) => u.id !== App.me.id && !memberIds.includes(u.id) && (!q || u.name.toLowerCase().includes(q))
  );
  const wrap = $("#invite-list");
  wrap.innerHTML = all.length
    ? all.map((u) => `
      <div class="friend-row">
        <div class="av">${avatarHTML(u)}</div>
        <div class="meta"><div class="n">${u.name}</div><div class="s">@${u.username} · ${(u.branch || "").split(" - ").pop()}</div></div>
        <button data-id="${u.id}">Invite</button>
      </div>`).join("")
    : `<div class="empty-state"><div class="e"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>No students found.</div>`;
  $all("#invite-list button").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      const originalLabel = b.textContent;
      b.textContent = "Sending…";
      try {
        await Store.inviteToGroup(groupId, App.me.id, b.dataset.id);
        b.textContent = "Invited";
        b.classList.add("added");
      } catch (err) {
        console.error("Invite failed:", err);
        toast("Couldn't send that invite — try again.");
        b.disabled = false;
        b.textContent = originalLabel;
      }
    })
  );
}

async function openInboxModal() {
  // Same stale-response guard as openBlockedModal — see its comment.
  const myModalToken = modalToken;
  await renderInboxList();
  if (myModalToken !== modalToken) return; // stale — something else changed modal state meanwhile
  openModal("inbox");
}

async function renderInboxList() {
  if (!App.me) return;
  const invites = await Store.getMyInvites(App.me.id);
  const all = await Store.allUsers();
  const usersById = {};
  all.forEach((u) => { usersById[u.id] = u; });
  const wrap = $("#inbox-list");
  wrap.innerHTML = invites.length
    ? invites.map((inv) => {
        const from = usersById[inv.fromId];
        return `
        <div class="friend-row" data-id="${inv.id}">
          <div class="av">${from ? avatarHTML(from) : ""}</div>
          <div class="meta"><div class="n">${inv.groupName || "Group"}</div><div class="s">Invited by ${from ? from.name : "someone"}</div></div>
          <div style="display:flex; gap:6px;">
            <button data-id="${inv.id}" data-action="accept">Accept</button>
            <button data-id="${inv.id}" data-action="decline" style="background:none;">Decline</button>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty-state"><div class="e"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18v13H3z"/><path d="M3 6l9 8 9-8"/></svg></div>No invitations right now.</div>`;
  $all("#inbox-list button").forEach((b) =>
    b.addEventListener("click", async () => {
      const accept = b.dataset.action === "accept";
      b.disabled = true;
      try {
        await Store.respondToInvite(b.dataset.id, accept);
        await renderInboxList();
        renderInboxBadge();
        renderGroupsList();
        toast(accept ? "Joined group" : "Invitation declined");
      } catch (err) {
        console.error("Respond to invite failed:", err);
        toast("Couldn't update that invitation — try again.");
        b.disabled = false;
      }
    })
  );
}

async function renderInboxBadge() {
  if (!App.me) return;
  try {
    const invites = await Store.getMyInvites(App.me.id);
    const dot = $("#dot-inbox");
    if (dot) dot.classList.toggle("show", invites.length > 0);
  } catch (err) { console.error("renderInboxBadge failed:", err); }
}
