'use strict';

const fs = require('fs');
const dns = require('dns').promises;
const tls = require('tls');

/* -------------------- utils -------------------- */

function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

function daysBetween(a, b) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/* -------------------- IP helpers -------------------- */

function parseIPv4ToU32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/* -------------------- rDNS -------------------- */

function looksDefaultRdns(host) {
  const h = host.toLowerCase();
  const patterns = [
    /\b\d{1,3}[-.]\d{1,3}[-.]\d{1,3}[-.]\d{1,3}\b/,
    /(static|dyn|dynamic|host|vps|vm|server|srv|node)\b/,
    /\b(ip|cust|customer)\b/,
    /(compute|cloud|vultr|linode|digitalocean|ovh|hetzner|aws|amazon|googleusercontent|azure|leaseweb|contabo|scaleway)\b/,
    /\bip[-.]\d{1,3}[-.]\d{1,3}[-.]\d{1,3}[-.]\d{1,3}\b/,
  ];
  return patterns.some((re) => re.test(h));
}

async function reverseDns(ip, timeoutMs = 1200) {
  try {
    const names = await withTimeout(dns.reverse(ip), timeoutMs);
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

/* -------------------- TLS (bonus-only) -------------------- */

async function fetchTlsCertMeta(ip, timeoutMs = 1800, servername) {
  return withTimeout(
    new Promise((resolve) => {
      const socket = tls.connect(
        {
          host: ip,
          port: 443,
          servername: servername || undefined,
          rejectUnauthorized: false,
        },
        () => {
          const cert = socket.getPeerCertificate(true);
          socket.end();
          if (!cert || !cert.valid_from) return resolve(null);
          resolve({
            valid_from: new Date(cert.valid_from),
          });
        }
      );

      socket.on('error', () => resolve(null));
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        resolve(null);
      });
    }),
    timeoutMs + 200
  );
}

/* -------------------- scoring -------------------- */

const DEFAULT_WEIGHTS = Object.freeze({
  datacenter_asn: 90,
  defaultish_rdns: 5,
  tls_age_le_7d: 5,
  tls_age_le_30d: 3,
  tls_age_le_90d: 1,
});

/* -------------------- precomputed index -------------------- */

let _idx = null;

function u32View(buf, offsetBytes, lengthU32) {
  return new Uint32Array(buf.buffer, buf.byteOffset + offsetBytes, lengthU32);
}

function loadPrecomputed(indexBinPath, asnMapJsonPath) {
  const buf = fs.readFileSync(indexBinPath);
  if (buf.slice(0, 4).toString('utf8') !== 'ASNV') {
    throw new Error('Invalid ASN index (bad magic)');
  }

  const version = buf.readUInt32LE(4);
  if (version !== 1) {
    throw new Error(`Unsupported ASN index version ${version}`);
  }

  const count = buf.readUInt32LE(8);
  let off = 16;

  const starts = u32View(buf, off, count); off += count * 4;
  const ends   = u32View(buf, off, count); off += count * 4;
  const asns   = u32View(buf, off, count); off += count * 4;
  const prefix16 = u32View(buf, off, 65536 * 2);

  const map = JSON.parse(fs.readFileSync(asnMapJsonPath, 'utf8'));
  const asnList = Uint32Array.from(map.asn);
  const isDcList = Uint8Array.from(map.isDc);

  _idx = { starts, ends, asns, prefix16, asnList, isDcList };
}

/* -------------------- ASN lookup -------------------- */

function binarySearchAsn(asnList, asn) {
  let lo = 0, hi = asnList.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = asnList[mid];
    if (v === asn) return mid;
    if (v < asn) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function binarySearchRange(starts, ends, asns, ipU32, lo, hiExclusive) {
  let l = lo;
  let r = hiExclusive - 1;
  let idx = -1;

  while (l <= r) {
    const mid = (l + r) >> 1;
    if (starts[mid] <= ipU32) {
      idx = mid;
      l = mid + 1;
    } else {
      r = mid - 1;
    }
  }

  if (idx === -1) return null;
  return ipU32 <= ends[idx] ? asns[idx] : null;
}

function lookupAsnAndDatacenter(ip) {
  if (!_idx) return null;

  const ipU32 = parseIPv4ToU32(ip);
  if (ipU32 === null) return null;

  const prefix = (ipU32 >>> 16) & 0xffff;
  const lo = _idx.prefix16[prefix * 2];
  const hi = _idx.prefix16[prefix * 2 + 1];

  const asn = binarySearchRange(_idx.starts, _idx.ends, _idx.asns, ipU32, lo, hi);
  if (!asn) return { asn: null, isDatacenter: false };

  const pos = binarySearchAsn(_idx.asnList, asn);
  const isDatacenter = pos >= 0 ? _idx.isDcList[pos] === 1 : false;

  return { asn, isDatacenter };
}

/* -------------------- main API -------------------- */

async function evaluateIp(ip, opts = {}) {
  const {
    indexBinPath,
    asnMapJsonPath,
    tlsServername,
    enableRdns = true,
    enableTlsAge = true,
    weights = {},
  } = opts;

  if (!_idx) {
    if (!indexBinPath || !asnMapJsonPath) {
      throw new Error('Missing indexBinPath / asnMapJsonPath');
    }
    loadPrecomputed(indexBinPath, asnMapJsonPath);
  }

  const W = { ...DEFAULT_WEIGHTS, ...weights };
  const reasons = [];
  const signals = {};

  /* ASN (primary) */
  const asnInfo = lookupAsnAndDatacenter(ip);
  signals.asn = asnInfo;

  const isDatacenter = Boolean(asnInfo && asnInfo.isDatacenter);
  if (isDatacenter) reasons.push('datacenter_asn');

  /* rDNS (supporting) */
  if (enableRdns) {
    const rdns = await reverseDns(ip);
    signals.rdns = rdns;
    if (rdns.length && rdns.some(looksDefaultRdns)) {
      reasons.push('defaultish_rdns');
    }
  }

  /* TLS age (bonus-only) */
  let ageHint = null;
  if (enableTlsAge) {
    const cert = await fetchTlsCertMeta(ip, 1800, tlsServername);
    signals.tlsCert = cert;

    if (cert && cert.valid_from instanceof Date) {
      const ageDays = daysBetween(new Date(), cert.valid_from);
      signals.tlsCertAgeDays = ageDays;

      if (ageDays <= 7) { reasons.push('tls_age_le_7d'); ageHint = 'very_fresh_tls'; }
      else if (ageDays <= 30) { reasons.push('tls_age_le_30d'); ageHint = 'fresh_tls'; }
      else if (ageDays <= 90) { reasons.push('tls_age_le_90d'); ageHint = 'moderately_fresh_tls'; }
      else { ageHint = 'older_tls'; }
    }
  }

  const uniqReasons = [...new Set(reasons)];
  let score = 0;
  for (const r of uniqReasons) if (typeof W[r] === 'number') score += W[r];
  score = clamp(score, 0, 100);

  let label = 'datacenter_unlikely';
  if (score >= 70) label = 'datacenter_likely';
  else if (score >= 40) label = 'datacenter_possible';

  return {
    isDatacenter,   // ✅ NEW boolean (fast path)
    score,
    label,
    ageHint,
    reasons: uniqReasons,
    signals,
  };
}

module.exports = {
  loadPrecomputed,
  evaluateIp,

  // exposed for testing / metrics
  lookupAsnAndDatacenter,
  DEFAULT_WEIGHTS,
};

