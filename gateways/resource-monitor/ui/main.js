const bytes = (value) => `${(value / 1073741824).toFixed(1)} GB`;
const percent = (used, total) => total > 0 ? Math.round(used / total * 100) : 0;

export function mount(host) {
  const root = document.createElement("main");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "LIVE HOST TELEMETRY";
  const title = document.createElement("h1");
  title.textContent = "Resource Monitor";
  const status = document.createElement("p");
  status.className = "status";
  status.textContent = "Connecting to collector…";
  const cards = document.createElement("section");
  cards.className = "cards";
  const card = (label) => {
    const article = document.createElement("article");
    const name = document.createElement("h2"); name.textContent = label;
    const value = document.createElement("strong"); value.textContent = "—";
    const detail = document.createElement("p");
    article.append(name, value, detail); cards.append(article);
    return { value, detail };
  };
  const cpu = card("CPU");
  const memory = card("Memory");
  const history = document.createElement("section");
  history.className = "history";
  const historyTitle = document.createElement("h2"); historyTitle.textContent = "Recent samples";
  const chart = document.createElement("div"); chart.className = "chart";
  history.append(historyTitle, chart);
  root.append(eyebrow, title, status, cards, history);
  host.root.replaceChildren(root);

  let stopped = false;
  const render = (samples) => {
    const ordered = [...samples].reverse();
    const latest = samples[0];
    if (!latest) { status.textContent = "Waiting for the first sample…"; return; }
    cpu.value.textContent = `${latest.cpuPercent.toFixed(1)}%`;
    cpu.detail.textContent = `Collected ${new Date(latest.collectedAt).toLocaleTimeString()}`;
    const memoryPercent = percent(latest.memoryUsedBytes, latest.memoryTotalBytes);
    memory.value.textContent = `${memoryPercent}%`;
    memory.detail.textContent = `${bytes(latest.memoryUsedBytes)} of ${bytes(latest.memoryTotalBytes)}`;
    status.textContent = "Collector online";
    chart.replaceChildren(...ordered.map((sample) => {
      const bar = document.createElement("span");
      bar.style.height = `${Math.max(2, sample.cpuPercent)}%`;
      bar.title = `${new Date(sample.collectedAt).toLocaleTimeString()} — CPU ${sample.cpuPercent.toFixed(1)}%`;
      return bar;
    }));
  };
  const refresh = async () => {
    try {
      const base = location.pathname.replace(/\/+$/u, "");
      const response = await fetch(`${base}/_gateway/v1/samples?limit=60`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      render(Array.isArray(body.samples) ? body.samples : []);
    } catch { status.textContent = "Collector data temporarily unavailable"; }
  };
  void refresh();
  const timer = setInterval(() => { if (!stopped) void refresh(); }, 5000);
  return () => { stopped = true; clearInterval(timer); host.root.replaceChildren(); };
}
