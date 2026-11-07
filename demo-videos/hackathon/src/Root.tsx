import React from "react";
import { Composition } from "remotion";
import { Card, Intro } from "./Cards";
import { EndCard } from "./EndCard";
import { Main, Solo, soloTotal, total } from "./Main";
import { FPS, H, W } from "./theme";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="TabDemo" component={Main} durationInFrames={total("release")} fps={FPS} width={W} height={H} defaultProps={{ second: "release" as const }} />
    <Composition id="TabDemoPR" component={Main} durationInFrames={total("pr")} fps={FPS} width={W} height={H} defaultProps={{ second: "pr" as const }} />
    <Composition id="TabDemoSolo" component={Solo} durationInFrames={soloTotal} fps={FPS} width={W} height={H} />
    <Composition id="Intro" component={Intro} durationInFrames={Math.round(4.6 * FPS)} fps={FPS} width={W} height={H} />
    <Composition id="Card" component={Card} durationInFrames={Math.round(1.75 * FPS)} fps={FPS} width={W} height={H} defaultProps={{ solid: "Do it once.", ghost: " Tab does the rest.", kicker: "Release day" }} />
    <Composition id="EndCard" component={EndCard} durationInFrames={Math.round(5.2 * FPS)} fps={FPS} width={W} height={H} defaultProps={{ tabDid: 121, youDid: 33 }} />
  </>
);
