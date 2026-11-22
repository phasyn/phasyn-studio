import { CylinderGeometry, Group, MathUtils, Mesh, SphereGeometry, type Material } from "three";
import type { StudioPrevisRig } from "@/api/generated/contracts";

/** Reusable joint and limb geometry; one unit spans the neutral puppet's height. Its face points towards +Z. */
export class PuppetGeometry {
  readonly ball = new SphereGeometry(1, 18, 12);
  readonly rod = new CylinderGeometry(1, 0.82, 1, 14);
  dispose() {
    this.ball.dispose();
    this.rod.dispose();
  }
  pose(s: StudioPrevisRig, material: Material): Group {
    const root = new Group();
    const pivot = (parent: Group, x: number, y: number, z = 0) => {
      const g = new Group();
      g.position.set(x, y, z);
      parent.add(g);
      return g;
    };
    const round = (parent: Group, x: number, y: number, z: number, w: number, h: number, d: number) => {
      const mesh = new Mesh(this.ball, material);
      mesh.scale.set(w, h, d);
      mesh.position.set(x, y, z);
      parent.add(mesh);
    };
    const bone = (parent: Group, len: number, r: number) => {
      const mesh = new Mesh(this.rod, material);
      mesh.scale.set(r, len, r);
      mesh.position.y = -len / 2;
      parent.add(mesh);
      round(parent, 0, 0, 0, r * 1.1, r * 1.1, r * 1.1);
      return pivot(parent, 0, -len);
    };
    const rad = MathUtils.degToRad;
    root.rotation.y = rad(s.body_yaw);
    round(root, 0, -0.025, 0, 0.125, 0.091, 0.084);
    const torso = pivot(root, 0, -0.012);
    torso.rotation.x = rad(s.body_pitch);
    round(torso, 0, 0.137, 0, 0.138, 0.19, 0.087);
    const head = pivot(torso, 0, 0.325);
    head.rotation.y = rad(s.head_yaw);
    round(head, 0, 0.058, 0, 0.089, 0.106, 0.083);
    round(head, 0, 0.055, 0.075, 0.025, 0.026, 0.031);
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      const shoulder = pivot(torso, sign * 0.138, 0.235);
      shoulder.rotation.order = "ZXY";
      shoulder.rotation.z = sign * rad(s[`${side}_arm_spread`]);
      shoulder.rotation.x = -rad(s[`${side}_arm_raise`]);
      const elbow = bone(shoulder, 0.155, 0.038);
      elbow.rotation.x = -rad(s[`${side}_elbow`]);
      const hand = bone(elbow, 0.14, 0.029);
      round(hand, 0, -0.032, 0, 0.032, 0.05, 0.025);
      const hip = pivot(root, sign * 0.072, -0.08);
      hip.rotation.order = "ZXY";
      hip.rotation.z = sign * rad(s[`${side}_leg_spread`]);
      hip.rotation.x = -rad(s[`${side}_hip`]);
      const knee = bone(hip, 0.19, 0.05);
      knee.rotation.x = rad(s[`${side}_knee`]);
      const foot = bone(knee, 0.182, 0.035);
      round(foot, 0, -0.012, 0.031, 0.04, 0.03, 0.076);
    }
    return root;
  }
}
