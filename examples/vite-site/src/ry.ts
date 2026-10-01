// Demo only: show where route-yes sent you from, using the cookie the Worker set.
const match = document.cookie.match(/(?:^|; )ry=([^;]+)/);
if (match) {
  document.cookie = "ry=; Path=/; Max-Age=0";
  try {
    const { from, info } = JSON.parse(decodeURIComponent(match[1]!)) as { from: string; info: string };
    const kind = info.split(";")[0];
    const confidence = Number(info.match(/confidence=([\d.]+)/)?.[1] ?? 0);
    const ms = info.match(/ms=(\d+)/)?.[1];

    const banner = document.createElement("div");
    banner.className = "ry-banner";
    const img = document.createElement("img");
    img.src = "/ry.jpeg";
    img.alt = "";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `ry routed you here from ${from}`;
    const detail = document.createElement("span");
    detail.textContent =
      kind === "normalized"
        ? "Fixed the URL without calling AI."
        : kind === "typo"
          ? "Fixed a typo without calling AI."
          : `Clef was ${Math.round(confidence * 100)}% sure${ms ? `, decided in ${(Number(ms) / 1000).toFixed(1)}s` : " (cached)"}.`;
    text.append(title, detail);
    banner.append(img, text);
    document.querySelector("main")?.prepend(banner);
  } catch {
    // Ignore a malformed cookie.
  }
}
