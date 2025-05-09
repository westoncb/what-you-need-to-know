import React, { useEffect, useState, useRef } from "react";
import type { CallInfo } from "@wyntn/common";

interface Props {
  call    : CallInfo;
  section : "input" | "prompt" | "output";
  onClose : () => void;
}

export function CallModal({ call, section, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const contentRef = useRef(null);
  const modalRef = useRef(null);

  const content =
    section === "input"  ? call.input  :
    section === "prompt" ? call.prompt :
    call.error ?? call.output;

  const formattedContent = typeof content === 'object' ?
    JSON.stringify(content, null, 2) :
    String(content);

  const title = section === "input" ? "Input" :
                section === "prompt" ? "Prompt" :
                call.error ? "Error" : "Output";

  const handleCopy = () => {
    navigator.clipboard.writeText(formattedContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Add animation
  useEffect(() => {
    if (modalRef.current) {
      modalRef.current.style.opacity = '0';
      setTimeout(() => {
        if (modalRef.current) modalRef.current.style.opacity = '1';
      }, 10);
    }
  }, []);

  const getStatusColor = () => {
    if (section === "output" && call.error) return "#ef5350";
    if (call.state === "run") return "#42a5f5";
    if (call.state === "done") return "#66bb6a";
    return "#ef5350"; // error
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return "—";
    const date = new Date(timestamp);
    return date.toLocaleTimeString() + "." + date.getMilliseconds().toString().padStart(3, '0');
  };

  const renderSyntaxHighlightedJSON = () => {
    if (typeof content !== 'object') return formattedContent;

    try {
      // Simple JSON syntax highlighting
      return formattedContent
        .replace(/"([^"]+)":/g, '<span style="color: #80cbc4;">"$1"</span>:')
        .replace(/"(true|false|null)"/g, '<span style="color: #7986cb;">$1</span>')
        .replace(/: "([^"]*)"/g, ': <span style="color: #c3e88d;">"$1"</span>')
        .replace(/: ([0-9]+)/g, ': <span style="color: #f78c6c;">$1</span>');
    } catch (e) {
      return formattedContent;
    }
  };

  const styles = {
    overlay: {
      zIndex: 1000,
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(2px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "opacity 0.2s ease-in-out",
      opacity: 0
    },
    modal: {
      display: "flex",
      flexDirection: "column",
      maxWidth: "85vw",
      maxHeight: "85vh",
      width: "800px",
      background: "#1e1e1e",
      color: "#eee",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
      border: "1px solid rgba(255,255,255,0.1)",
      overflow: "hidden"
    },
    header: {
      display: "flex",
      alignItems: "center",
      padding: "12px 16px",
      borderBottom: "1px solid rgba(255,255,255,0.1)",
      background: "#2d2d2d"
    },
    title: {
      display: "flex",
      alignItems: "center",
      fontSize: "16px",
      fontWeight: 500,
      color: "#fff",
      marginRight: "auto"
    },
    statusIndicator: {
      width: "10px",
      height: "10px",
      borderRadius: "50%",
      marginRight: "8px"
    },
    infoRow: {
      display: "flex",
      fontSize: "12px",
      color: "#aaa",
      marginTop: "4px"
    },
    infoItem: {
      marginRight: "12px"
    },
    contentContainer: {
      overflowY: "auto",
      overflowX: "auto",
      padding: "4px"
    },
    pre: {
      margin: 0,
      padding: "16px",
      fontSize: "14px",
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all"
    },
    controls: {
      display: "flex",
      padding: "8px 16px",
      borderTop: "1px solid rgba(255,255,255,0.1)",
      background: "#2d2d2d",
      justifyContent: "flex-end"
    },
    button: {
      background: "#444",
      color: "#fff",
      border: "none",
      borderRadius: "4px",
      padding: "6px 12px",
      fontSize: "13px",
      cursor: "pointer",
      marginLeft: "8px",
      display: "flex",
      alignItems: "center",
      transition: "background 0.15s ease"
    },
    buttonHover: {
      background: "#555"
    },
    buttonCopied: {
      background: "#43a047",
    },
    closeIcon: {
      cursor: "pointer",
      padding: "4px",
      marginLeft: "8px",
      opacity: 0.7,
      transition: "opacity 0.15s ease"
    },
    closeIconHover: {
      opacity: 1
    }
  };

  // For button hover states
  const [buttonHover, setButtonHover] = useState(null);
  const [closeHover, setCloseHover] = useState(false);

  return (
    <div
      ref={modalRef}
      style={styles.overlay}
      onClick={onClose}
    >
      <div
        style={styles.modal}
        onClick={e => e.stopPropagation()}
      >
        <div style={styles.header}>
          <div style={styles.title}>
            <div style={{
              ...styles.statusIndicator,
              backgroundColor: getStatusColor()
            }} />
            {title} Detail
          </div>

          <div style={{
            ...styles.closeIcon,
            ...(closeHover ? styles.closeIconHover : {})
          }}
            onClick={onClose}
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
          >
            ✕
          </div>
        </div>

        <div style={styles.infoRow}>
          <div style={styles.infoItem}>ID: {call.id}</div>
          <div style={styles.infoItem}>Started: {formatTime(call.started)}</div>
          {call.latency && <div style={styles.infoItem}>Latency: {call.latency}ms</div>}
          <div style={styles.infoItem}>Status: {call.state}</div>
        </div>

        <div style={styles.contentContainer} ref={contentRef}>
          {typeof content === 'object' ? (
            <pre
              style={styles.pre}
              dangerouslySetInnerHTML={{ __html: renderSyntaxHighlightedJSON() }}
            />
          ) : (
            <pre style={styles.pre}>{formattedContent}</pre>
          )}
        </div>

        <div style={styles.controls}>
          <button
            style={{
              ...styles.button,
              ...(buttonHover === 'close' ? styles.buttonHover : {}),
            }}
            onClick={onClose}
            onMouseEnter={() => setButtonHover('close')}
            onMouseLeave={() => setButtonHover(null)}
          >
            Close
          </button>

          <button
            style={{
              ...styles.button,
              ...(buttonHover === 'copy' ? styles.buttonHover : {}),
              ...(copied ? styles.buttonCopied : {})
            }}
            onClick={handleCopy}
            onMouseEnter={() => setButtonHover('copy')}
            onMouseLeave={() => setButtonHover(null)}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
