const url = "http://192.168.1.51/api/v1/notify";
try {
  const res = await fetch(url);
  console.log("Status:", res.status);
} catch (err) {
  console.error("Fetch failed:", err);
}
