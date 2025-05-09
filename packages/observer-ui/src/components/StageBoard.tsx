import React, { useState, useEffect } from "react";
import { useFlow } from "../FlowCtx.jsx";
import { StageColumn } from "./StageColumn.jsx";

export function StageBoard() {
  const { stages } = useFlow();
  const [activeStages, setActiveStages] = useState(0);
  const [totalCalls, setTotalCalls] = useState(0);
  const [runningCalls, setRunningCalls] = useState(0);
  const [refreshTime, setRefreshTime] = useState(new Date());

  // Sort columns by ID
  const cols = [...stages.values()].sort((a, b) => a.id?.localeCompare(b.id));

  // Calculate statistics
  useEffect(() => {
    let active = 0;
    let total = 0;
    let running = 0;

    for (const stage of stages.values()) {
      if (stage.calls && stage.calls.length > 0) active++;
      if (stage.calls) total += stage.calls.length;
      if (stage.openCalls) running += stage.openCalls;
    }

    setActiveStages(active);
    setTotalCalls(total);
    setRunningCalls(running);
    setRefreshTime(new Date());
  }, [stages]);

  const styles = {
    container: {
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      background: "#f8f9fa",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    },
    header: {
      padding: "12px 16px",
      borderBottom: "1px solid #e0e0e0",
      background: "#fff",
      boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      zIndex: 10
    },
    titleRow: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    },
    title: {
      fontSize: "20px",
      fontWeight: "600",
      color: "#333",
      margin: 0
    },
    subtitle: {
      color: "#666",
      fontSize: "13px",
      marginTop: "4px"
    },
    statsContainer: {
      display: "flex",
      alignItems: "center",
      marginTop: "12px"
    },
    statBox: {
      display: "flex",
      flexDirection: "column",
      padding: "8px 16px",
      marginRight: "12px",
      background: "#f1f3f5",
      borderRadius: "6px",
      minWidth: "100px"
    },
    statValue: {
      fontSize: "18px",
      fontWeight: "600",
      color: "#333"
    },
    statLabel: {
      fontSize: "12px",
      color: "#666",
      marginTop: "2px"
    },
    runningStatBox: {
      background: "#e3f2fd",
      color: "#1976d2"
    },
    refreshTime: {
      fontSize: "12px",
      color: "#999",
      marginLeft: "auto",
      alignSelf: "flex-end"
    },
    columnsContainer: {
      display: "flex",
      gap: "16px",
      padding: "16px",
      overflowX: "auto",
      overflowY: "hidden",
      height: "calc(100vh - 120px)" // Adjust based on header height
    },
    noStages: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      color: "#999",
      fontSize: "16px",
      padding: "40px"
    },
    noStagesIcon: {
      fontSize: "32px",
      marginBottom: "16px",
      opacity: 0.5
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>Flow Observer</h1>
          <div style={styles.refreshTime}>
            Last updated: {refreshTime.toLocaleTimeString()}
          </div>
        </div>
        <div style={styles.subtitle}>
          Monitoring {stages.size} stages with {activeStages} active
        </div>

        <div style={styles.statsContainer}>
          <div style={styles.statBox}>
            <div style={styles.statValue}>{totalCalls}</div>
            <div style={styles.statLabel}>Total Calls</div>
          </div>

          {runningCalls > 0 && (
            <div style={{...styles.statBox, ...styles.runningStatBox}}>
              <div style={{...styles.statValue, color: "#1976d2"}}>{runningCalls}</div>
              <div style={{...styles.statLabel, color: "#1976d2"}}>Running</div>
            </div>
          )}
        </div>
      </div>

      <div style={styles.columnsContainer}>
        {cols.length > 0 ? (
          cols.map(s => <StageColumn key={s.id} stage={s} />)
        ) : (
          <div style={styles.noStages}>
            <div style={styles.noStagesIcon}>⏱</div>
            <div>Waiting for stages to appear...</div>
          </div>
        )}
      </div>
    </div>
  );
}
