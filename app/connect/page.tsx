type ConnectPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getParam(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export default async function ConnectPage({ searchParams }: ConnectPageProps) {
  const params = searchParams ? await searchParams : {};
  const token = getParam(params.token);
  const status = getParam(params.status);
  const email = getParam(params.email);

  return (
    <main className="shell">
      <section className="panel">
        <p className="eyebrow">Pocket Secretary</p>
        <h1>Connect Google</h1>
        {status === "connected" ? (
          <p className="lede">
            Google account connected
            {email ? `: ${email}` : ""}. Return to Telegram and send a request.
          </p>
        ) : status ? (
          <p className="lede">
            Connection failed or expired. Go back to Telegram and send
            <code> /start</code> to get a fresh link.
          </p>
        ) : token ? (
          <>
            <p className="lede">
              This links your Telegram bot identity to your Google account for
              Calendar, Gmail, Docs, and Contacts access.
            </p>
            <div className="actions">
              <a className="primary" href={`/api/oauth/google?token=${encodeURIComponent(token)}`}>
                Connect Google
              </a>
            </div>
          </>
        ) : (
          <p className="lede">
            Open this page from the Telegram connect link so Pocket Secretary
            can associate your Google account with your bot user.
          </p>
        )}
      </section>
    </main>
  );
}
