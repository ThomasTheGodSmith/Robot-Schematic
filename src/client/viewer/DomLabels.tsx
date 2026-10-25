import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";

export interface LabelSpec {
  key: string;
  position: THREE.Vector3 | [number, number, number];
  text: string;
  className?: string;
  title?: string;
}

/**
 * Screen-space HTML labels for points in the 3D scene. Managed imperatively
 * (plain DOM nodes positioned every frame) so mounting/unmounting never
 * creates or tears down React roots inside the render loop.
 */
export function DomLabels({ labels }: { labels: LabelSpec[] }) {
  const { gl, camera, size } = useThree();
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const layer = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parent = gl.domElement.parentElement;
    if (!parent) return;
    const div = document.createElement("div");
    div.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    parent.appendChild(div);
    layer.current = div;
    return () => {
      div.remove();
      layer.current = null;
      nodes.current.clear();
    };
  }, [gl]);

  useEffect(() => {
    const div = layer.current;
    if (!div) return;
    const keep = new Set(labels.map((l) => l.key));
    for (const [k, n] of nodes.current)
      if (!keep.has(k)) {
        n.remove();
        nodes.current.delete(k);
      }
    for (const l of labels) {
      let n = nodes.current.get(l.key);
      if (!n) {
        n = document.createElement("div");
        n.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;will-change:transform";
        div.appendChild(n);
        nodes.current.set(l.key, n);
      }
      n.className = l.className ?? "";
      n.textContent = l.text;
      if (l.title) n.title = l.title;
    }
  }, [labels]);

  const v = new THREE.Vector3();
  useFrame(() => {
    for (const l of labels) {
      const n = nodes.current.get(l.key);
      if (!n) continue;
      if (Array.isArray(l.position)) v.set(...l.position);
      else v.copy(l.position);
      v.project(camera);
      const visible = v.z < 1 && v.z > -1;
      n.style.display = visible ? "" : "none";
      const x = ((v.x + 1) / 2) * size.width, y = ((1 - v.y) / 2) * size.height;
      n.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  });
  return null;
}
