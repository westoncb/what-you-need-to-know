import React from "react";
import "../index.css";          // path is relative to src/components

export default function App() {
  return (
    <main className="main">
      <h1>WYNTN — What You Need To Know</h1>
      <p className="subtle">
        Daily multiscale memetic gradient estimate (MVP scaffold)
      </p>

      <div className="card">
        <h2>No reports yet</h2>
        <p className="subtle">
          Run <code>pnpm news:fetch &amp;&amp; pnpm mmge:run &amp;&amp; pnpm site:export</code>,
          then rebuild to see today&rsquo;s analysis here.
        </p>
      </div>
    </main>
  );
}
