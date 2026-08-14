/* ============================================================================
   geo.js — device GPS tracking, wired to the campus map
   ----------------------------------------------------------------------------
   Uses the real browser Geolocation API (navigator.geolocation.watchPosition),
   so on a phone this genuinely tracks the device's real position. It converts
   that lat/lon into a normalized map position with geoToImage() from
   config.js and reports campus in/out status via isInsideCampus().
   ========================================================================== */

const Geo = {
  watchId: null,
  lastFix: null, // {lat, lon, accuracy, ts}
  listeners: [],

  // ---- smoothing state (raw GPS is noisy — every real phone's lat/lon
  // wobbles by several metres even standing perfectly still, which is
  // what read as the pin "blinking"/jumping around). We keep a running
  // smoothed estimate and only ever move it a fraction of the way toward
  // each new raw fix, instead of teleporting straight to it. ----
  _smoothLat: null,
  _smoothLon: null,

  onUpdate(fn) {
    this.listeners.push(fn);
  },

  _emit(fix) {
    this.lastFix = fix;
    this.listeners.forEach((fn) => fn(fix));
  },

  /** Smooth a raw fix without lagging behind real movement. Pure
   *  accuracy-weighted damping (the previous version) treated every new
   *  fix the same regardless of how far it actually moved, which meant
   *  it also damped genuine walking movement — that read as "the pin
   *  isn't tracking my real position accurately" (correct complaint: it
   *  was lagging). This version checks the actual distance between the
   *  last smoothed point and the new raw fix:
   *    - if that distance is bigger than the fix's own accuracy radius,
   *      it's almost certainly real movement, not GPS noise — trust it
   *      immediately (alpha≈1, no lag).
   *    - if it's smaller than the accuracy radius, it's most likely just
   *      GPS wobble around a stationary point — damp it heavily so the
   *      pin holds still instead of jittering.
   *  That keeps you accurately tracked while walking AND steady while
   *  standing still, instead of trading one for the other. */
  _smooth(latitude, longitude, accuracy) {
    if (this._smoothLat === null) {
      this._smoothLat = latitude;
      this._smoothLon = longitude;
      return { lat: latitude, lon: longitude };
    }
    const acc = typeof accuracy === "number" && accuracy > 0 ? accuracy : 25;
    const dLat = (latitude - this._smoothLat) * 111320;
    const dLon = (longitude - this._smoothLon) * 111320 * Math.cos((latitude * Math.PI) / 180);
    const distMeters = Math.hypot(dLat, dLon);

    // STILLNESS DEAD-ZONE: a phone's GPS chip reports a *new* lat/lon on
    // every fix even standing dead still — typically wobbling a few
    // metres in a random direction each time. That's a hardware/satellite-
    // geometry limit (multipath reflections, atmospheric delay, receiver
    // noise); no app-side code can make consumer GPS report a fixed point
    // to zero error. What we CAN do is stop chasing that wobble: if the
    // new fix falls well within its own reported accuracy radius of where
    // we already think you are, treat it as noise around a stationary
    // point and don't move at all — rather than the old behaviour of
    // always nudging toward it (alpha floor of 0.12), which is exactly
    // what read as "I'm steady but it keeps moving".
    const stillRadius = Math.max(3, acc * 0.5);
    if (distMeters < stillRadius) {
      return { lat: this._smoothLat, lon: this._smoothLon };
    }

    const alpha = distMeters > acc ? 0.95 : Math.min(0.4, Math.max(0.15, 10 / acc));
    this._smoothLat += (latitude - this._smoothLat) * alpha;
    this._smoothLon += (longitude - this._smoothLon) * alpha;
    return { lat: this._smoothLat, lon: this._smoothLon };
  },

  start() {
    if (!("geolocation" in navigator)) {
      this._emit({ error: "no-geo" });
      return;
    }
    // Guard against ever running two watchers at once (e.g. start() called
    // twice across a screen re-entry) — duplicate watchers would double-
    // fire every update and could race each other.
    if (this.watchId !== null) return;
    this._smoothLat = null;
    this._smoothLon = null;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        // Reject wildly inaccurate fixes outright instead of feeding them
        // into the smoother. A single fix with e.g. 150m accuracy (the
        // chip briefly falling back to WiFi/cell-tower positioning) can
        // look like "real movement" to the distance-vs-accuracy check in
        // _smooth() and teleport the dot before snapping back on the next
        // good fix. Once we have an established position, ignore anything
        // worse than 60m accuracy entirely rather than acting on it.
        if (typeof accuracy === "number" && accuracy > 60 && this._smoothLat !== null) return;
        const smoothed = this._smooth(latitude, longitude, accuracy);
        const inside = isInsideCampus(smoothed.lat, smoothed.lon);
        const img = geoToImage(smoothed.lat, smoothed.lon);
        this._emit({
          lat: smoothed.lat,
          lon: smoothed.lon,
          rawLat: latitude,
          rawLon: longitude,
          accuracy,
          inside,
          nx: img.x,
          ny: img.y,
          ts: Date.now(),
        });
      },
      (err) => {
        this._emit({ error: err.message || "geo-error" });
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  },

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this._smoothLat = null;
    this._smoothLon = null;
  },

  /** For desktop/demo browsers without real campus GPS: simulate a walk. */
  startDemoWalk() {
    if (this._demoInterval) return; // already running — don't stack a second one
    // Wander around the central lawn/A-block area, inside campus bounds.
    const path = [
      { x: 0.30, y: 0.55 }, { x: 0.32, y: 0.60 }, { x: 0.30, y: 0.65 },
      { x: 0.27, y: 0.62 }, { x: 0.26, y: 0.55 }, { x: 0.30, y: 0.50 },
    ];
    let i = 0;
    this._emit({ ...path[0], nx: path[0].x, ny: path[0].y, inside: true, demo: true, accuracy: 6, ts: Date.now() });
    this._demoInterval = setInterval(() => {
      i = (i + 1) % path.length;
      const p = path[i];
      this._emit({ nx: p.x, ny: p.y, inside: true, demo: true, accuracy: 6, ts: Date.now() });
    }, 4000);
  },
  stopDemoWalk() {
    if (this._demoInterval) clearInterval(this._demoInterval);
    this._demoInterval = null;
  },
};
