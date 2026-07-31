// api/suggest.js
// Vercel serverless function: GET /api/suggest?q=orc
//
// Lightweight proxy over OneMap's free search API, used for live
// autocomplete as the user types (like Google Maps' search box). Returns
// a short list of matching places with their postal code, so the frontend
// can let people search by name ("orchard") while the actual carpark
// lookup still runs on a precise 6-digit postal code under the hood.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const q = (req.query.q || "").trim();
    if (q.length < 2) {
      res.status(200).json({ results: [] });
      return;
    }

    const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
      q
    )}&returnGeom=N&getAddrDetails=Y&pageNum=1`;
    const r = await fetch(url);
    if (!r.ok) {
      res.status(200).json({ results: [] }); // fail soft - autocomplete is non-critical
      return;
    }
    const json = await r.json();
    const raw = json?.results || [];

    const results = raw
      .filter((item) => item.POSTAL && /^\d{6}$/.test(item.POSTAL))
      .slice(0, 6)
      .map((item) => ({
        label: item.BUILDING && item.BUILDING !== "NIL" ? item.BUILDING : item.ROAD_NAME,
        address: item.ADDRESS,
        postal: item.POSTAL,
      }));

    res.status(200).json({ results });
  } catch (err) {
    res.status(200).json({ results: [] }); // fail soft
  }
};
