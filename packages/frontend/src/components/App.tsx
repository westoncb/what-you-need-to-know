import React, { useState, useEffect } from "react";
import "./article-style.css";

export default function App() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Helper function to get local date in YYYY-MM-DD format
  const getLocalDateString = () => {
    // Get current date in local timezone (Phoenix, AZ - MST/PDT)
    const now = new Date();

    // Format the date as YYYY-MM-DD using local timezone
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  };

  useEffect(() => {
    const fetchReport = async () => {
      try {
        setLoading(true);

        // Get date in local timezone format
        const dateString = getLocalDateString();
        console.log(`Fetching report for local date: ${dateString}`);

        const response = await fetch(`/data/${dateString}.json`);

        if (!response.ok) {
          throw new Error(`Failed to fetch report: ${response.status}`);
        }

        const data = await response.json();
        setReport(data);
        setLoading(false);
      } catch (err) {
        console.error("Error loading report:", err);
        setError(err.message);
        setLoading(false);
      }
    };

    fetchReport();
  }, []);

  // If loading, show minimal loading indicator
  if (loading) {
    return <div className="loading">Loading today's report...</div>;
  }

  // If error, show minimal error message
  if (error) {
    return <div className="error">Could not load report: {error}</div>;
  }

  // If we have a report, render it
  if (report && report.narrative_html) {
    return (
      <div
        dangerouslySetInnerHTML={{ __html: report.narrative_html }}
      />
    );
  }

  // Fallback if we have nothing to display
  return <div>No report available.</div>;
}
