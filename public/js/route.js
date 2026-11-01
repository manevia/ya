// Route optimiser for meter readers and technicians. Pure client-side (works offline): nearest-neighbour start, then 2-opt improvement.
const R = 6371;
export function km(a, b) { const t = x => x * Math.PI / 180; const dLa = t(b.lat - a.lat), dLo = t(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const length = (start, pts) => pts.reduce((s, p, i) => s + km(i ? pts[i - 1] : start, p), 0);
/** Order points (each {lat,lng,...}) starting from `start` ({lat,lng}); points without coordinates go last. */
export function planRoute(start, points) {
  const geo = points.filter(p => p.lat != null && p.lng != null), rest = points.filter(p => p.lat == null || p.lng == null);
  if (!geo.length) return { order: points, km: 0, unlocated: rest.length };
  const s = start && start.lat != null ? start : geo[0];
  const left = [...geo]; const tour = [];
  let cur = s;
  while (left.length) { let bi = 0, bd = Infinity; left.forEach((p, i) => { const d = km(cur, p); if (d < bd) { bd = d; bi = i; } }); cur = left.splice(bi, 1)[0]; tour.push(cur); }
  // 2-opt (open path): reverse segments while it shortens the walk
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < tour.length - 1; i++) for (let k = i + 1; k < tour.length; k++) {
      const a = i ? tour[i - 1] : s, b = tour[i], c = tour[k], d = tour[k + 1];
      const before = km(a, b) + (d ? km(c, d) : 0), after = km(a, c) + (d ? km(b, d) : 0);
      if (after + 1e-9 < before) { tour.splice(i, k - i + 1, ...tour.slice(i, k + 1).reverse()); improved = true; }
    }
  }
  const naive = length(s, geo);
  return { order: [...tour, ...rest], km: Math.round(length(s, tour) * 100) / 100, naive_km: Math.round(naive * 100) / 100, unlocated: rest.length, start: s };
}
export function myPosition(timeout = 8000) {
  return new Promise(res => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 120000 }); });
}
export const osmDirections = (from, to) => `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${from.lat}%2C${from.lng}%3B${to.lat}%2C${to.lng}`;
