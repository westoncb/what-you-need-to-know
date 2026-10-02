import React, { useEffect, useRef, useId } from "react";
import "./LightWeightModal.css";

const LightweightModal = ({ isOpen, onClose, title, content }) => {
  const modalRef = useRef(null);
  const titleId = useId();

  // Close when clicking outside the modal
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      // Prevent scrolling of background content
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.body.style.overflow = "auto";
    };
  }, [isOpen, onClose]);

  // Close on ESC key
  useEffect(() => {
    const handleEsc = (event) => {
      if (event.keyCode === 27) onClose();
    };

    if (isOpen) {
      window.addEventListener("keydown", handleEsc);
    }

    return () => {
      window.removeEventListener("keydown", handleEsc);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-container" ref={modalRef}>
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button className="modal-close" aria-label="Close dialog" onClick={onClose}>×</button>
        </div>
        <div className="modal-content">
          {content}
        </div>
      </div>
    </div>
  );
};

export default LightweightModal;
