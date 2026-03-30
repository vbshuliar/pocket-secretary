import Link from "next/link";

const capabilities = [
  "Telegram local polling runner",
  "Voice transcription and action orchestration",
  "Google Calendar, Gmail, and Docs integrations",
  "Upstash-backed confirmation state",
];

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Pocket Secretary</p>
        <h1>Telegram messages turned into real Google actions.</h1>
        <p className="lede">
          This Next.js app is the local control plane for Pocket Secretary. Run
          the web app and the Telegram poller together to connect Google,
          transcribe voice notes, and execute Google Workspace actions.
        </p>
        <div className="actions">
          <Link href="/chat" className="primary">
            Open app shell
          </Link>
          <Link href="/api/health" className="secondary">
            Health check
          </Link>
        </div>
      </section>

      <section className="panel">
        <h2>MVP surface</h2>
        <ul>
          {capabilities.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
