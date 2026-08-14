/* ============================================================================
   store.js — local persistence + simulated multi-user data
   ----------------------------------------------------------------------------
   IMPORTANT — READ THIS:
   There is no real server here. Everything lives in this browser's
   localStorage. That's enough to demo and design every screen and
   interaction faithfully, but it means:
     - "Other students" you see on the map are SIMULATED demo accounts,
       not real classmates.
     - Comments/likes you post are only visible in *this* browser.
     - The @darshan.ac.in login is a FORMAT check only — there's no real
       mail server verifying you actually own that inbox.
   To make this a real multi-device app, swap this file's functions for
   calls to a real backend (Supabase/your own API). Every function
   below is written as `async` on purpose so that swap is a drop-in change.
   See README.md → "Going to production" for the exact plan.
   ========================================================================== */

const DB_KEY = "cc_db_v1";
// BRANCHES now lives in js/constants.js (shared with the Supabase store variant)

function seedDemoStudents() {
  const names = [
    ["Aarav Mehta", "aarav.mehta"], ["Diya Shah", "diya.shah"],
    ["Kabir Joshi", "kabir.joshi"], ["Isha Patel", "isha.patel"],
    ["Vivaan Rana", "vivaan.rana"], ["Anaya Gohil", "anaya.gohil"],
    ["Reyansh Sindhav", "reyansh.s"], ["Myra Kariya", "myra.kariya"],
  ];
  const places = ["Boys Hostel - Block H", "Girls Hostel", "Rajkot City", "Morbi", "Jamnagar", "Gondal"];
  const statuses = ["Single", "Taken"];
  const regions = JSON.parse(localStorage.getItem("cc_regions_cache") || "null");

  return names.map(([name, uname], i) => {
    const branch = BRANCHES[i % BRANCHES.length];
    const sem = (i % 8) + 1;
    // scatter demo students at plausible normalized positions inside campus
    const spots = [
      { x: 0.34, y: 0.58 }, { x: 0.34, y: 0.78 }, { x: 0.26, y: 0.45 },
      { x: 0.46, y: 0.17 }, { x: 0.35, y: 0.06 }, { x: 0.24, y: 0.58 },
      { x: 0.34, y: 0.37 }, { x: 0.11, y: 0.83 },
    ];
    return {
      id: "demo-" + i,
      enrollment: `22CE0${100 + i}`,
      email: `22CE0${100 + i}@darshan.ac.in`,
      name,
      username: uname,
      photo: null, // rendered as initials avatar
      age: 19 + (i % 4),
      branch,
      semester: sem,
      place: places[i % places.length],
      relationship: statuses[i % statuses.length],
      phone: "",
      social: "",
      pos: spots[i],
      active: i % 3 !== 0, // most are "active"
      locationOn: true, // demo students always have "GPS" on
      lastSeen: Date.now() - i * 60000,
    };
  });
}

const Store = {
  _read() {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
    const fresh = {
      currentUserId: null,
      users: {}, // id -> profile
      friends: {}, // userId -> [friendId,...]
      blocked: {}, // userId -> [blockedId,...]
      comments: [], // {id, fromId, toId, text, ts}
      likes: [], // {id, fromId, toId, ts}
      seenTabs: { map: true, comments: true, likes: true }, // true = no red dot
    };
    seedDemoStudents().forEach((s) => (fresh.users[s.id] = s));
    localStorage.setItem(DB_KEY, JSON.stringify(fresh));
    return fresh;
  },
  _write(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  },

  async getDb() {
    return this._read();
  },
  async saveUser(profile) {
    const db = this._read();
    db.users[profile.id] = profile;
    this._write(db);
    return profile;
  },
  async setCurrentUser(id) {
    const db = this._read();
    db.currentUserId = id;
    this._write(db);
  },
  async getCurrentUser() {
    const db = this._read();
    return db.currentUserId ? db.users[db.currentUserId] : null;
  },
  async isUsernameTaken(username, excludeId) {
    const db = this._read();
    return Object.values(db.users).some(
      (u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== excludeId
    );
  },
  async findByEnrollment(enrollment) {
    const db = this._read();
    return Object.values(db.users).find((u) => u.enrollment === enrollment) || null;
  },
  async allUsers() {
    const db = this._read();
    return Object.values(db.users);
  },
  async updatePosition(id, pos) {
    const db = this._read();
    if (db.users[id]) {
      db.users[id].pos = pos;
      db.users[id].active = true;
      db.users[id].locationOn = true; // a fresh fix means GPS is on
      db.users[id].lastSeen = Date.now();
      this._write(db);
    }
  },

  /** Flip whether this user's device currently has GPS/location on. The
   *  map only renders a pin for a user while this is true — see
   *  renderMapPins() in app.js. */
  async updateLocationStatus(id, isOn) {
    const db = this._read();
    if (db.users[id]) {
      db.users[id].locationOn = isOn;
      this._write(db);
    }
  },

  async toggleFriend(userId, targetId) {
    const db = this._read();
    db.friends[userId] = db.friends[userId] || [];
    const idx = db.friends[userId].indexOf(targetId);
    if (idx >= 0) db.friends[userId].splice(idx, 1);
    else db.friends[userId].push(targetId);
    this._write(db);
    return db.friends[userId];
  },
  async getFriends(userId) {
    const db = this._read();
    return db.friends[userId] || [];
  },

  async toggleBlock(userId, targetId) {
    const db = this._read();
    db.blocked[userId] = db.blocked[userId] || [];
    const idx = db.blocked[userId].indexOf(targetId);
    if (idx >= 0) db.blocked[userId].splice(idx, 1);
    else db.blocked[userId].push(targetId);
    this._write(db);
    return db.blocked[userId];
  },
  async getBlocked(userId) {
    const db = this._read();
    return db.blocked[userId] || [];
  },

  async addComment(fromId, toId, text) {
    const db = this._read();
    const c = { id: "c" + Date.now() + Math.random().toString(16).slice(2), fromId, toId, text, ts: Date.now() };
    db.comments.unshift(c);
    db.seenTabs.comments = false;
    this._write(db);
    return c;
  },
  async getComments() {
    const db = this._read();
    return db.comments;
  },

  async addLike(fromId, toId) {
    const db = this._read();
    const l = { id: "l" + Date.now() + Math.random().toString(16).slice(2), fromId, toId, ts: Date.now() };
    db.likes.unshift(l);
    db.seenTabs.likes = false;
    this._write(db);
    return l;
  },
  async getLikes() {
    const db = this._read();
    return db.likes;
  },

  async markTabSeen(tab) {
    const db = this._read();
    db.seenTabs[tab] = true;
    this._write(db);
  },
  async getUnseenTabs() {
    const db = this._read();
    return db.seenTabs;
  },
};

/* ----------------------------------------------------------------------
   Auth (local mode) — instant, no real email verification.
   This exists so app.js can call the same Auth.* interface regardless of
   AUTH_MODE. The Supabase version in store.supabase.js implements the
   same three methods but with a real magic-link email round trip.
   ---------------------------------------------------------------------- */
const Auth = {
  /** @returns {Promise<{instant:boolean, user:object}>} */
  async sendLoginLink(enrollment) {
    let user = await Store.findByEnrollment(enrollment);
    if (!user) {
      user = {
        id: "u-" + enrollment,
        enrollment,
        email: `${enrollment}@darshan.ac.in`,
        name: "", username: "", photo: null, age: "", branch: BRANCHES[0],
        semester: 1, placeType: "hostel", place: "", relationship: "",
        phone: "", social: "", pos: { x: 0.35, y: 0.55 }, active: true,
        locationOn: true, onboarded: false, lastSeen: Date.now(),
      };
      await Store.saveUser(user);
    }
    await Store.setCurrentUser(user.id);
    return { instant: true, user };
  },
  /** @returns {Promise<{loggedIn:boolean, user:object|null}>} */
  async tryCompleteSignIn() {
    const user = await Store.getCurrentUser();
    return { loggedIn: !!user, user };
  },
  async signOut() {
    await Store.setCurrentUser(null);
  },
};
