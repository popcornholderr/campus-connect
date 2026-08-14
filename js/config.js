/* ============================================================================
   config.js — Geo-calibration for the campus map
   ----------------------------------------------------------------------------
   The map image (assets/campus-map.jpg) was calibrated against 7 known
   real-world GPS points that were manually marked on the source map.
   A least-squares affine fit converts between (lat, lon) and NORMALIZED
   image position (nx, ny each 0..1, independent of the image's displayed
   pixel size). This is the same math QGIS/ArcGIS "ground control points"
   georeferencing uses, just solved directly with linear least squares
   because 7 points on a rigid image is an easy, well-conditioned fit.

   Residual error against the 7 control points was ~0.5-1% of image size
   (~3-4 metres on the ground) — accurate enough to place a person's dot
   correctly relative to buildings, but NOT survey-grade. If you re-shoot
   or replace the base map, re-run /tools/calibrate.py (see README) and
   paste the new coefficients here.
   ========================================================================== */

const CAMPUS_CONFIG = {
  // Forward transform: geographic -> normalized image space
  // nx = a*lon + b*lat + c
  // ny = d*lon + e*lat + f
  transform: {
    a: 200.59204712682666,
    b: 70.17992422372265,
    c: -15772.646583829803,
    d: 104.7699181165247,
    e: -369.2185428432106,
    f: 866.3552144251933,
  },

  // Inverse 2x2 matrix of [[a,b],[d,e]] used to go image -> geographic
  // (only needed by the calibration tool, kept here for completeness)
  inverse: {
    m11: 0.004535015955061278,
    m12: 0.0008620018746315414,
    m21: 0.0012868618315052217,
    m22: -0.002463820281542207,
  },

  // The 8 boundary points that define the playable/trackable campus area.
  // Used to build a point-in-polygon fence: outside this shape the app
  // shows "you're outside campus range".
  boundary: [
    { lat: 22.432455555555556, lon: 70.78498055555555 },
    { lat: 22.43209722222222, lon: 70.78356388888889 },
    { lat: 22.431319444444444, lon: 70.783725 },
    { lat: 22.431019444444445, lon: 70.78263055555556 },
    { lat: 22.429344444444446, lon: 70.78296944444445 },
    { lat: 22.429655555555556, lon: 70.7852361111111 },
    { lat: 22.431441666666668, lon: 70.78482777777778 },
    { lat: 22.431597222222223, lon: 70.78525555555555 },
  ],

  mapImage: "assets/campus-map.jpg",
  mapAspect: 2600 / 1605, // width / height of the shipped jpg

  university: {
    emailDomain: "@darshan.ac.in",
    name: "Darshan University",
  },
};

/** lat/lon -> {x, y} normalized 0..1 within the map image */
function geoToImage(lat, lon) {
  const t = CAMPUS_CONFIG.transform;
  return {
    x: t.a * lon + t.b * lat + t.c,
    y: t.d * lon + t.e * lat + t.f,
  };
}

/** normalized image {x,y} 0..1 -> {lat, lon} (approximate, inverse fit) */
function imageToGeo(x, y) {
  const t = CAMPUS_CONFIG.transform;
  const inv = CAMPUS_CONFIG.inverse;
  const rx = x - t.c;
  const ry = y - t.f;
  return {
    lon: inv.m11 * rx + inv.m12 * ry,
    lat: inv.m21 * rx + inv.m22 * ry,
  };
}

/** Point-in-polygon (ray casting) on the lat/lon boundary */
function isInsideCampus(lat, lon) {
  const poly = CAMPUS_CONFIG.boundary;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon, yi = poly[i].lat;
    const xj = poly[j].lon, yj = poly[j].lat;
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
