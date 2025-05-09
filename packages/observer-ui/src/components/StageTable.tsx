import React from "react";

type Props = {
  stages: Record<
    string,
    {
      name: string;
      status: string;
      totals: { in: number; out: number; err: number };
    }
  >;
};

export default function StageTable({ stages }: Props) {
  const rows = Object.entries(stages);
  if (!rows.length) return <p style={{ margin: "1rem" }}>Waiting for data…</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Stage</th>
          <th>Status</th>
          <th>In</th>
          <th>Out</th>
          <th>Err</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, s]) => (
          <tr key={id}>
            <td>{id}</td>
            <td>{s.name}</td>
            <td className={s.status}>{s.status}</td>
            <td>{s.totals.in}</td>
            <td>{s.totals.out}</td>
            <td>{s.totals.err}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
