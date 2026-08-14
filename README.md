# Campus Connect — Darshan University campus map app

A working front-end prototype of everything you described: enrollment-only
login, guided profile setup, a live map built from your own campus image
(not Google Maps) with real GPS pins, tap-to-see profile cards, comments and
likes with floating on-map bubbles/hearts, friends/blocking, search, and a
4-tab bottom nav with unread dots.

## Run it

No build step. Just serve the folder (opening `index.html` directly with
`file://` will block the GPS API in most browsers, so use a tiny local
server):

```bash
cd campus-connect
python3 -m http.server 8000
# then open http://localhost:8000 on your phone or laptop
```

For real GPS testing on your phone, it needs to be served over **HTTPS**
(or `localhost`) — browsers refuse geolocation on plain HTTP. Easiest path:
deploy to Vercel/Netlify/GitHub Pages (all free, all give you HTTPS) and
open that URL on your phone while on campus.

## What's real vs. simulated — please read this before demoing it

I built this as a fully working **single-device** prototype. Everything you
asked for is implemented and clickable, but a few things are necessarily
mocked because there's no real backend here:

| Feature | Status |
|---|---|
| Your own GPS position on the map | **Real.** Uses `navigator.geolocation.watchPosition`, converted to map pixels via a geo-calibration fit (see below). |
| Campus boundary fence / "outside range" screen | **Real**, checked against the 8 corner coordinates you gave. |
| Login restricted to `@darshan.ac.in` format | **Real format check.** There's no mail server here to actually verify you own that inbox / send an OTP — see "Going to production" below for what that needs. |
| One account per enrollment number | **Real within this browser's storage.** Without a server, nothing stops someone from clearing browser storage and re-registering — that dedup has to live server-side. |
| Other students' pins, their comments/likes on you | **Simulated.** 8 demo classmates ship with the app, and a background timer occasionally has one of them comment or like your pin so you can see the live bubble/heart/red-dot behavior without a second phone. Clearly marked in `js/store.js`. |
| Comments/likes you send | Saved to **this browser's local storage only** — not visible from another device. |
| Profanity filter | **Real**, runs on every comment before it's posted (`js/profanity.js`). |

None of this is a shortcut you need to fix later out of laziness — it's the
honest boundary of what a browser-only app can do. The whole thing is
structured so swapping the mock layer for a real backend is a contained,
one-file change (see below).

## How the map calibration works

You gave me 7 marked points with known GPS coordinates and 8 GPS corner
points. I:

1. Programmatically detected the 7 red dots in your marked image (pixel
   color/cluster analysis, not guessing) and zoomed into each to read its
   number.
2. Fit a least-squares affine transform between (lat, lon) and normalized
   image position from those 7 control points — the same approach
   GIS tools use for "ground control point" georeferencing.
3. Stored that transform in `js/config.js`, along with the 8 boundary
   points, so any GPS fix can be converted to a map pixel and checked
   against the campus fence.

Residual error against the 7 known points was roughly 0.5–1% of the image
size (a few metres on the ground) — plenty accurate for "which building is
this pin near," not survey-grade. If you re-shoot the base map or want
tighter accuracy, re-run the fit (`tools/calibrate.py`-style script, or ask
me) with more control points spread further apart.

## Region labels ("Opposite of A block", "H-block", etc.)

`assets/regions.json` has my best-effort reading of every label from your
annotated image, each with an approximate normalized (x, y) position. The
app uses "nearest labeled point" to a pin's position to show things like
"Near G-block" in a profile card — deliberately simple rather than true
polygon boundaries, because tracing 25+ irregular hand-drawn polygon
outlines precisely from a compressed screenshot isn't something I can do
reliably from image inspection alone.

**`tools/region-mapper.html` fixes this properly**: open it, click exactly
on each region on the full map, name it, and it exports ready-to-paste
JSON with pixel-accurate coordinates. Ten minutes of clicking gets you a
much better dataset than my estimate. Swap it into `assets/regions.json`.

## Fixes made in this pass

- **Firebase is gone.** Every Firebase file/folder removed; `js/store.supabase.js` replaces `store.firebase.js` with the same interface, so nothing else in the app needed to change.
- **Profile photo upload fixed.** The upload path now has real timeouts and surfaces a real error message if it fails, instead of silently hanging on "Saving…" — the actual bug under Firebase was almost certainly a Storage CORS configuration issue; Supabase Storage's plain REST upload doesn't have that failure mode.
- **Map pan/zoom tuned.** Mouse-wheel/trackpad zoom is now ~3x gentler and normalized across input devices (a trackpad's tiny scroll deltas and a mouse's big notched ones used to zoom at very different, unpredictable rates). Releasing a drag now glides to a stop with momentum/friction instead of dead-stopping, which is the biggest single thing that made it feel like a real map app instead of a scrollable webpage.
- **Buttons feel instant now.** The "slow blue flash" on tap was the browser's own default tap-highlight overlay, not a CSS bug — disabled globally (`-webkit-tap-highlight-color: transparent`) and replaced with a fast (~80ms) custom press animation applied consistently across every button, row, and map pin.

## Going to production — the Supabase backend is now built in

`js/store.supabase.js` is a complete, real implementation: Google OAuth
(hard-restricted to `@darshan.ac.in`, your Google Workspace domain),
Postgres tables for users/comments/likes, Supabase Storage for profile
photos, and realtime subscriptions so pins, comments, and likes update
live across real devices — not just in one browser tab. It implements the
exact same method names as the local demo store, so `js/app.js` didn't
need to change to support it.

### Supabase setup (about 10 minutes)

1. **Create a project.** Go to [supabase.com/dashboard](https://supabase.com/dashboard) → New project. Free tier is enough to launch on. Pick a database password and save it somewhere (you won't need it for this app, but Supabase requires setting one).
2. **Run the schema.** Dashboard → SQL Editor → New query → paste in the entire contents of `supabase/schema.sql` → Run. This creates the `users`/`comments`/`likes` tables, locks them down with Row Level Security, and sets up the profile-photo storage bucket — all in one script.
3. **Enable Google sign-in.** Dashboard → Authentication → Providers → Google → toggle it on. You'll need a Google Cloud OAuth Client ID/Secret:
   - Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.
   - Under "Authorized redirect URIs," add the callback URL Supabase shows you on that same Google provider settings page (it looks like `https://xxxx.supabase.co/auth/v1/callback`).
   - Copy the resulting Client ID and Client Secret back into Supabase's Google provider settings and save.
   - Since your students already have `@darshan.ac.in` Google Workspace accounts, no extra domain verification is needed on Google's side — this is standard "Sign in with Google" setup, not a Workspace admin action.
4. **Copy your project keys** into `js/supabase-config.js`: Dashboard → Project Settings → API → copy the "Project URL" and the "anon public" key (**not** the `service_role` key — that one must never go in client-side code).
5. **Add your app's URL to Supabase's allowed redirect URLs**: Dashboard → Authentication → URL Configuration → add both `http://localhost:8000` (for local testing) and your real deployed HTTPS URL once you have one, under "Redirect URLs" — otherwise Google will bounce back to a page Supabase refuses to complete sign-in on.
6. **Deploy the static files anywhere** — Netlify, Vercel, GitHub Pages, Cloudflare Pages all work and are free; there's no build step, it's just static files. Any of them gives you HTTPS automatically, which real GPS requires.

That's it — `AUTH_MODE` is already set to `"supabase"` and the script tags in `index.html` are already pointed at the Supabase files, so once steps 1-5 are done the app is live.

### What changes in behavior once it's configured

- Login is real Google sign-in, restricted to `@darshan.ac.in` accounts (checked both client-side and server-side by the RLS policies in `supabase/schema.sql` — the server-side check is the one that actually can't be bypassed).
- One account per Google account is guaranteed by Supabase Auth itself.
- Profile photos upload to Supabase Storage as real files; the `users` table only ever stores the resulting public URL.
- Comments and likes are private in the database itself — RLS policies only let the two people involved in a comment/like read it, not "any signed-in user."
- The client-side "simulated classmates" activity timer automatically turns itself off — real activity from real students drives the map/bubbles/red-dots instead.
- The 8 demo students from the local build won't appear — the directory starts empty and fills up as real students sign in.

## File map

```
campus-connect/
  index.html                all screens (login, onboarding, map, tabs)
  css/style.css              design system + all styling
  js/constants.js            AUTH_MODE switch + shared branch list
  js/config.js               geo-calibration + campus boundary
  js/geo.js                  GPS watch + demo-walk fallback
  js/profanity.js            comment content filter
  js/store.js                local demo data layer (no setup needed — for testing only)
  js/store.supabase.js       real backend: Auth + Postgres + Storage + realtime
  js/supabase-config.js      your Supabase project URL + anon key go here
  js/app.js                  all UI logic / rendering / event wiring (backend-agnostic)
  assets/campus-map.jpg      your clean map, compressed for web
  assets/regions.json        region label positions (rough — refine with the tool below)
  tools/region-mapper.html   click-to-calibrate region names precisely
  supabase/
    schema.sql               tables + Row Level Security policies + storage bucket, run once
```

