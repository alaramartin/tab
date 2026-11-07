import React from "react";
import { Composition } from "remotion";
import { DemoA } from "./A";
import { DemoB } from "./B";
import { DemoC } from "./C";
import { FPS, H, TOTAL, W } from "./edit";
import { TOTAL_A2 } from "./editA2";

// One composition per art direction, named like its renders in demo_videos/ (<id>-v<N>.mp4); each holds the latest version.
export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="tab-poster" component={DemoA} durationInFrames={TOTAL_A2} fps={FPS} width={W} height={H} />
    <Composition id="tab-ghost" component={DemoB} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
    <Composition id="tab-accept" component={DemoC} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
  </>
);
