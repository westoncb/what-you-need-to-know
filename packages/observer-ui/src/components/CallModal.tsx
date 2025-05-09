import React from "react";
import { CallInfo } from "@wyntn/common/index.js";

export function CallModal({ call, onClose }:{call:CallInfo; onClose:()=>void}) {
  return (
    <div style={{
      position:"fixed", top:0, left:0, right:0, bottom:0,
      background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center"
    }} onClick={onClose}>
      <pre style={{
        background:"#fff", padding:20, maxWidth:800, maxHeight:600, overflow:"auto"
      }} onClick={e => e.stopPropagation()}>
        {JSON.stringify(call, null, 2)}
      </pre>
    </div>
  );
}
