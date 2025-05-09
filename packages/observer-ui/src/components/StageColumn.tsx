import React from "react";
import { CallModal } from "./CallModal.jsx";
import type { CallInfo, StageInfo } from "@wyntn/common";

/* ───────────── helpers ───────────── */
function snippet(v, bytes = 40) {
  if (v === null || v === undefined) {
    return "—";
  }
  return typeof v === "string"
    ? v.slice(0, bytes)
    : JSON.stringify(v).slice(0, bytes);
}

const styles = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #e0e0e0',
    borderRadius: '6px',
    overflow: 'hidden',
    marginBottom: '12px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
    backgroundColor: '#fff',
    maxWidth: '100%'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: '#f7f7f7',
    borderBottom: '1px solid #e0e0e0'
  },
  statusIndicator: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    marginRight: '8px'
  },
  statusLabel: {
    fontSize: '13px',
    fontWeight: '500',
    color: '#444'
  },
  timestamp: {
    marginLeft: 'auto',
    fontSize: '12px',
    color: '#777'
  },
  content: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    borderTop: '1px solid #f0f0f0'
  },
  section: {
    padding: '10px 12px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    overflow: 'hidden',
    position: 'relative'
  },
  sectionHover: {
    backgroundColor: '#f9f9f9'
  },
  sectionLabel: {
    fontSize: '11px',
    fontWeight: '500',
    color: '#777',
    marginBottom: '4px',
    textTransform: 'uppercase'
  },
  sectionContent: {
    fontSize: '13px',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: '#333'
  },
  error: {
    color: '#e53935'
  },
  divider: {
    borderLeft: '1px solid #eaeaea'
  }
};

/* ───────────── card ───────────── */
export function CallCard({ call }) {
  const [open, setOpen] = React.useState(null);
  const [hover, setHover] = React.useState(null);

  if (!call) return null;

  const getStatusInfo = (state) => {
    switch(state) {
      case "run":
        return { color: "#3B82F6", label: "Running", icon: "⟳" };
      case "done":
        return { color: "#10B981", label: "Complete", icon: "✓" };
      default:
        return { color: "#EF4444", label: "Error", icon: "✗" };
    }
  };

  const statusInfo = getStatusInfo(call.state || "error");

  // Safely extract values from call to prevent object rendering issues
  const inputValue = call.input !== undefined ? snippet(call.input) : "—";
  const promptValue = call.prompt ? snippet(call.prompt) : "—";
  const outputValue = call.error
    ? `Error: ${snippet(call.error)}`
    : (call.output !== undefined ? snippet(call.output) : "—");

  return (
    <>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <div style={{display: 'flex', alignItems: 'center'}}>
            <div
              style={{...styles.statusIndicator, backgroundColor: statusInfo.color}}
            />
            <span style={styles.statusLabel}>{statusInfo.label}</span>
          </div>
          <div style={styles.timestamp}>
            {call.started ? new Date(call.started).toLocaleTimeString() : "—"}
          </div>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {/* Input */}
          <div
            onClick={() => setOpen("input")}
            onMouseEnter={() => setHover("input")}
            onMouseLeave={() => setHover(null)}
            style={{
              ...styles.section,
              ...(hover === "input" ? styles.sectionHover : {})
            }}
          >
            <div style={styles.sectionLabel}>Input</div>
            <div style={styles.sectionContent}>
              {inputValue}
            </div>
          </div>

          {/* Prompt */}
          <div
            onClick={() => setOpen("prompt")}
            onMouseEnter={() => setHover("prompt")}
            onMouseLeave={() => setHover(null)}
            style={{
              ...styles.section,
              ...styles.divider,
              ...(hover === "prompt" ? styles.sectionHover : {})
            }}
          >
            <div style={styles.sectionLabel}>Prompt</div>
            <div style={styles.sectionContent}>
              {promptValue}
            </div>
          </div>

          {/* Output */}
          <div
            onClick={() => setOpen("output")}
            onMouseEnter={() => setHover("output")}
            onMouseLeave={() => setHover(null)}
            style={{
              ...styles.section,
              ...styles.divider,
              ...(hover === "output" ? styles.sectionHover : {})
            }}
          >
            <div style={styles.sectionLabel}>Output</div>
            <div style={{
              ...styles.sectionContent,
              ...(call.error ? styles.error : {})
            }}>
              {outputValue}
            </div>
          </div>
        </div>
      </div>

      {open && (
        <CallModal call={call} section={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/* ───────────── stage column ───────────── */
export function StageColumn({ stage }) {
  const columnStyles = {
    container: {
      display: 'flex',
      flexDirection: 'column',
      margin: '0 8px',
      width: '100%',
      maxWidth: '100%',
      minWidth: '300px',
      overflow: 'hidden'
    },
    header: {
      padding: '10px 12px',
      marginBottom: '8px',
      borderBottom: '2px solid #e0e0e0',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    },
    stageInfo: {
      display: 'flex',
      flexDirection: 'column'
    },
    titleRow: {
      display: 'flex',
      alignItems: 'center',
      marginBottom: '4px'
    },
    title: {
      fontSize: '16px',
      fontWeight: '600',
      color: '#333',
      marginRight: '8px'
    },
    kind: {
      fontSize: '12px',
      color: '#fff',
      backgroundColor: '#666',
      padding: '1px 6px',
      borderRadius: '10px',
      textTransform: 'uppercase'
    },
    stats: {
      display: 'flex',
      fontSize: '12px',
      color: '#666'
    },
    stat: {
      marginRight: '12px'
    },
    counts: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end'
    },
    count: {
      fontSize: '13px',
      color: '#666',
      backgroundColor: '#f0f0f0',
      padding: '2px 8px',
      borderRadius: '12px',
      marginBottom: '4px'
    },
    openCount: {
      fontSize: '12px',
      color: '#3B82F6'
    },
    list: {
      overflowY: 'auto',
      maxHeight: 'calc(100vh - 150px)',
      paddingRight: '4px'
    },
    noData: {
      padding: '20px',
      textAlign: 'center',
      color: '#999',
      backgroundColor: '#f9f9f9',
      borderRadius: '4px',
      fontSize: '14px'
    }
  };

  if (!stage) return null;

  // Make sure we have a valid calls array
  const calls = Array.isArray(stage.callList) ? stage.callList : [];

  // Get counts and stats
  const totalCalls = calls.length;
  const openCalls = stage.openCalls || 0;

  // Format kind badge color
  const kindColors = {
    'cpu': '#666',
    'llm': '#8e44ad'
  };
  const kindColor = kindColors[stage.kind] || '#666';

  return (
    <div style={columnStyles.container}>
      <div style={columnStyles.header}>
        <div style={columnStyles.stageInfo}>
          <div style={columnStyles.titleRow}>
            <div style={columnStyles.title}>{stage.name || 'Unknown'}</div>
            <div style={{...columnStyles.kind, backgroundColor: kindColor}}>{stage.kind || 'unknown'}</div>
          </div>
          <div style={columnStyles.stats}>
            <div style={columnStyles.stat}>Calls: {stage.calls}</div>
            <div style={columnStyles.stat}>Open calls: {stage.openCalls}</div>
            <div style={columnStyles.stat}>Err: {stage.errors}</div>
          </div>
        </div>

        <div style={columnStyles.counts}>
          <div style={columnStyles.count}>{totalCalls}</div>
          {openCalls > 0 &&
            <div style={columnStyles.openCount}>{openCalls} open</div>
          }
        </div>
      </div>

      <div style={columnStyles.list}>
        {totalCalls > 0 ? (
          calls.map((call, i) => (
            <CallCard key={call.id || i} call={call} />
          ))
        ) : (
          <div style={columnStyles.noData}>No calls to display</div>
        )}
      </div>
    </div>
  );
}
