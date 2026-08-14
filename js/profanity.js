/* ============================================================================
   profanity.js — comment/message content filter
   ----------------------------------------------------------------------------
   Two tiers:
     1. STANDARD_BLOCKLIST — profanity/slurs/harassment terms. Censored with
        asterisks so the comment can still be posted in a cleaned form.
     2. HARD_BLOCKLIST — CSAM, terrorism, extreme-harm terms. These NEVER get
        censored-and-allowed; the whole comment is rejected outright, and
        (in a real deployment) should also be flagged to a moderator/Trust &
        Safety queue rather than silently dropped.
   Matching is done on a normalized version of the text (lowercased, common
   leetspeak substitutions folded, punctuation/spacing between letters
   stripped) so simple obfuscation like "f u c k" or "f*ck" is still caught.
   ========================================================================== */

const STANDARD_BLOCKLIST = [
  "fuck","fuk","fck","fucc","fuxk","phuck","phuk","phuc",
  "shit","shyt","sh1t",
  "bitch","biatch","btch",
  "asshole","a$$hole","assh0le",
  "dick","dik",
  "cock",
  "pussy","puss",
  "slut","sl0t",
  "hoe","hoes",
  "whore","wh0re",
  "faggot","fag",
  "nigga","nigger",
  "motherfucker","motherfuker","mofo",
  "madarchod","madar chod",
  "behenchod","behen chod","bhenchod","bc",
  "chutiya","chutiye","chut",
  "bhosdike","bhosdiya","bhosdiyo","bhosdi",
  "randi",
  "kamina","kamine",
  "gandu","gaand","gand",
  "lund",
  "loda",
  "maa ki aankh","teri maa","teri maa ki","teri behen","teri bhen",
  "lavdo","lavda","lavdi","laude","lavde","loude",
  "gaand maro","gaandmaro",
  "nakamo","nakama",
  "gando","gandi",
  "gadedo","gadeda",
  "kukro","kukra",
  "tari maa","tari ben",
  "taro baap",
  "bhad ma ja","bhadma ja",
  "sex","seks","secks","seggs","segg",
  "sexual","sexy","horny",
  "blowjob","bj",
  "handjob","hj",
  "boobs","boobies",
  "tits",
  "nudes","send nudes",
  "porn","pr0n",
  "xxx",
  "chudai","chudna","chodna","chod","chodu","chodi","chudelo","chudeli",
  "sambhog","suhagrat","suhaagrat",
  "lauda sex","lavda sex",
  "kill",
  "rape",
  "yoni","shishn","shishna",
];

// Always blocked outright — comment is rejected, not just censored.
const HARD_BLOCKLIST = [
  "child porn","childporn","pedo","pedophile","pedophilia","loli","shota",
  "isis","isil","al qaeda","alqaeda","jihad","terrorism","terrorist",
  "bomb making","how to make bomb","suicide bomb","mass shooting","school shooting",
];

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[@$4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/[^a-z\s]/g, "") // strip other punctuation/symbols
    .replace(/(.)\1{2,}/g, "$1$1") // collapse 3+ repeats (fuuuck -> fuuck)
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(normalizedText, term) {
  const t = term.toLowerCase().replace(/[^a-z\s]/g, "");
  // also check with spaces between letters stripped out, e.g. "f u c k"
  const collapsed = normalizedText.replace(/\s+/g, "");
  return normalizedText.includes(t) || collapsed.includes(t.replace(/\s+/g, ""));
}

/**
 * @returns {{allowed: boolean, cleaned: string, hardBlocked: boolean, hits: string[]}}
 */
function moderateComment(rawText) {
  const norm = normalize(rawText);
  const hardHit = HARD_BLOCKLIST.find((t) => containsTerm(norm, t));
  if (hardHit) {
    return { allowed: false, cleaned: "", hardBlocked: true, hits: [hardHit] };
  }

  let cleaned = rawText;
  const hits = [];
  STANDARD_BLOCKLIST.forEach((term) => {
    if (containsTerm(norm, term)) {
      hits.push(term);
      // best-effort in-place censor using a case-insensitive, space-tolerant regex
      const pattern = term
        .split("")
        .map((ch) => (ch === " " ? "[\\s]*" : `${ch}[\\s\\*\\.\\-_]*`))
        .join("");
      const re = new RegExp(pattern, "gi");
      cleaned = cleaned.replace(re, (m) => "*".repeat(m.length));
    }
  });

  return { allowed: true, cleaned, hardBlocked: false, hits };
}
