import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Html5Audio,
  Img,
  interpolate,
  registerRoot,
  staticFile,
  useCurrentFrame,
} from "remotion";

const FPS = 30;
const DURATION_IN_FRAMES = 15 * FPS;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

const palette = {
  paper: "#f7f8fc",
  surface: "#ffffff",
  ink: "#18191d",
  muted: "#6f7280",
  line: "#dfe2ea",
  blue: "#2f5cd8",
  blueSoft: "#e9efff",
  purple: "#7857d8",
} as const;

const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

function progress(frame: number, start: number, end: number): number {
  return interpolate(frame, [start, end], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function sceneOpacity(frame: number, start: number, end: number, fade = 14): number {
  const fadeIn = start === 0 ? 1 : progress(frame, start, start + fade);
  const fadeOut = end === DURATION_IN_FRAMES ? 1 : 1 - progress(frame, end - fade, end);
  return Math.min(fadeIn, fadeOut);
}

function BrandBar({ label = "T3 Code, now multiplayer" }: { label?: string }) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "space-between",
        left: 64,
        position: "absolute",
        right: 64,
        top: 42,
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 14 }}>
        <div
          style={{
            alignItems: "center",
            background: palette.ink,
            borderRadius: 9,
            color: "white",
            display: "flex",
            fontSize: 18,
            fontWeight: 750,
            height: 36,
            justifyContent: "center",
            width: 36,
          }}
        >
          C
        </div>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" }}>Campfire</span>
      </div>
      <span style={{ color: palette.muted, fontSize: 14, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function ProductShot({
  children,
  focus = "50% 50%",
  src,
  zoom = 1,
}: {
  children?: ReactNode;
  focus?: string;
  src: string;
  zoom?: number;
}) {
  return (
    <div
      style={{
        background: palette.surface,
        border: `1px solid ${palette.line}`,
        boxShadow: "0 8px 30px rgba(39, 47, 72, 0.11)",
        height: 820,
        left: 64,
        overflow: "hidden",
        position: "absolute",
        top: 112,
        width: 1472,
      }}
    >
      <Img
        src={staticFile(src)}
        style={{
          height: "100%",
          objectFit: "cover",
          transform: `scale(${zoom})`,
          transformOrigin: focus,
          width: "100%",
        }}
      />
      {children}
    </div>
  );
}

function Label({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: "rgba(24, 25, 29, 0.94)",
        borderRadius: 999,
        color: "white",
        fontSize: 18,
        fontWeight: 680,
        lineHeight: 1,
        padding: "14px 20px",
        position: "absolute",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Cursor({ x, y, pressed = 0 }: { x: number; y: number; pressed?: number }) {
  return (
    <div
      style={{ left: x, position: "absolute", top: y, transform: `scale(${1 - pressed * 0.08})` }}
    >
      {pressed > 0 && (
        <div
          style={{
            border: `3px solid rgba(47, 92, 216, ${0.5 * (1 - pressed)})`,
            borderRadius: "50%",
            height: 54 + pressed * 26,
            left: -24 - pressed * 13,
            position: "absolute",
            top: -24 - pressed * 13,
            width: 54 + pressed * 26,
          }}
        />
      )}
      <svg height="42" viewBox="0 0 32 42" width="32">
        <path
          d="M3 2L28 24L17 25L23 37L16 40L10 27L3 35Z"
          fill="white"
          stroke={palette.ink}
          strokeLinejoin="round"
          strokeWidth="2.2"
        />
      </svg>
    </div>
  );
}

function Intro({ frame }: { frame: number }) {
  const reveal = progress(frame, 4, 28);
  const secondLine = progress(frame, 28, 52);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, 0, 70) }}>
      <BrandBar label="A thin fork of T3 Code" />
      <div style={{ left: 150, position: "absolute", top: 300, width: 1270 }}>
        <div
          style={{
            color: palette.muted,
            fontSize: 31,
            fontWeight: 520,
            opacity: reveal,
            transform: `translateY(${(1 - reveal) * 18}px)`,
          }}
        >
          The agent workspace was already here.
        </div>
        <div
          style={{
            fontSize: 82,
            fontWeight: 720,
            letterSpacing: "-0.045em",
            lineHeight: 1.02,
            marginTop: 24,
            opacity: secondLine,
            transform: `translateY(${(1 - secondLine) * 22}px)`,
          }}
        >
          We brought the team into it.
        </div>
      </div>
    </AbsoluteFill>
  );
}

function SharedSidebar({ frame }: { frame: number }) {
  const enter = progress(frame, 52, 82);
  return (
    <AbsoluteFill
      style={{
        opacity: sceneOpacity(frame, 56, 132),
        transform: `scale(${0.985 + enter * 0.015})`,
      }}
    >
      <BrandBar />
      <ProductShot focus="0% 50%" src="docs/assets/campfire-app-thread.png" zoom={1.04}>
        <div
          style={{
            background: "rgba(47, 92, 216, 0.07)",
            border: "2px solid rgba(47, 92, 216, 0.55)",
            bottom: 0,
            left: 0,
            position: "absolute",
            top: 0,
            width: 238,
          }}
        />
        <Label style={{ left: 270, top: 42 }}>Every teammate&apos;s threads. One sidebar.</Label>
      </ProductShot>
    </AbsoluteFill>
  );
}

function TakeALook({ frame }: { frame: number }) {
  const enter = progress(frame, 116, 144);
  const click = progress(frame, 164, 177);
  const notice = progress(frame, 178, 205);
  const cursorX = interpolate(enter, [0, 1], [1180, 1050]);
  const cursorY = interpolate(enter, [0, 1], [660, 455]);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, 118, 218) }}>
      <BrandBar label="Bring in the teammate who can unblock it" />
      <ProductShot focus="72% 45%" src="docs/assets/campfire-app-thread.png" zoom={1.06}>
        <div
          style={{
            background: palette.ink,
            borderRadius: 999,
            color: "white",
            fontSize: 17,
            fontWeight: 700,
            left: 967,
            padding: "14px 22px",
            position: "absolute",
            top: 326,
          }}
        >
          Take a Look
        </div>
        <Cursor pressed={click < 0.5 ? click * 2 : (1 - click) * 2} x={cursorX} y={cursorY} />
        <div
          style={{
            background: palette.surface,
            border: `1px solid ${palette.line}`,
            boxShadow: "0 8px 26px rgba(39, 47, 72, 0.14)",
            opacity: notice,
            padding: "18px 20px",
            position: "absolute",
            right: 36,
            top: 42,
            transform: `translateY(${(1 - notice) * -14}px)`,
            width: 320,
          }}
        >
          <div style={{ color: palette.blue, fontSize: 13, fontWeight: 750 }}>
            TAKE A LOOK · BEN
          </div>
          <div style={{ fontSize: 17, fontWeight: 650, marginTop: 9 }}>
            Ship the onboarding together
          </div>
          <div style={{ color: palette.muted, fontSize: 14, marginTop: 5 }}>
            Ada needs your judgment in this run.
          </div>
        </div>
      </ProductShot>
    </AbsoluteFill>
  );
}

function SharedControl({ frame }: { frame: number }) {
  const joined = progress(frame, 210, 238);
  const message = progress(frame, 246, 278);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, 210, 304) }}>
      <BrandBar label="The same thread. The same agent." />
      <ProductShot focus="72% 34%" src="docs/assets/campfire-app-thread.png" zoom={1.035}>
        <div
          style={{
            alignItems: "center",
            background: palette.surface,
            border: `1px solid ${palette.line}`,
            display: "flex",
            gap: 12,
            opacity: joined,
            padding: "10px 14px",
            position: "absolute",
            right: 44,
            top: 35,
            transform: `translateY(${(1 - joined) * -12}px)`,
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "#f6bdc8",
              borderRadius: "50%",
              display: "flex",
              fontSize: 12,
              fontWeight: 750,
              height: 30,
              justifyContent: "center",
              width: 30,
            }}
          >
            BR
          </div>
          <span style={{ fontSize: 15, fontWeight: 650 }}>Ben joined this thread</span>
        </div>
        <div
          style={{
            background: palette.blueSoft,
            border: "1px solid rgba(47, 92, 216, 0.24)",
            fontSize: 17,
            lineHeight: 1.45,
            opacity: message,
            padding: "17px 20px",
            position: "absolute",
            right: 170,
            top: 580,
            transform: `translateY(${(1 - message) * 16}px)`,
            width: 550,
          }}
        >
          I checked the mobile spacing. Keep the reconnect note visible and ship it.
          <div style={{ color: palette.muted, fontSize: 12, marginTop: 8 }}>
            Ben Roy · to the agent
          </div>
        </div>
      </ProductShot>
    </AbsoluteFill>
  );
}

function TeamDiscussion({ frame }: { frame: number }) {
  const enter = progress(frame, 292, 326);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, 292, 382) }}>
      <BrandBar label="Human context stays beside the run" />
      <ProductShot focus="100% 50%" src="docs/assets/campfire-app-team-discussion.png" zoom={1.015}>
        <div
          style={{
            background: "rgba(47, 92, 216, 0.05)",
            borderLeft: "2px solid rgba(47, 92, 216, 0.45)",
            bottom: 0,
            opacity: enter,
            position: "absolute",
            right: 0,
            top: 0,
            transform: `translateX(${(1 - enter) * 58}px)`,
            width: 406,
          }}
        />
        <Label style={{ left: 730, top: 54 }}>Team discussion, attached to the run.</Label>
      </ProductShot>
    </AbsoluteFill>
  );
}

function MoreWorkflows({ frame }: { frame: number }) {
  const enter = progress(frame, 366, 392);
  const features = ["Private briefing", "PR review threads", "Shared controls"];
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, 368, 420) }}>
      <BrandBar label="Opinionated workflows, narrow fork" />
      <ProductShot focus="50% 25%" src="docs/assets/campfire-app-thread.png" zoom={1.025}>
        <div
          style={{
            alignItems: "center",
            backdropFilter: "blur(3px)",
            background: "rgba(247, 248, 252, 0.88)",
            bottom: 0,
            display: "flex",
            gap: 16,
            justifyContent: "center",
            left: 0,
            opacity: enter,
            position: "absolute",
            right: 0,
            top: 0,
          }}
        >
          {features.map((feature, index) => {
            const featureEnter = progress(frame, 374 + index * 6, 398 + index * 6);
            return (
              <div
                key={feature}
                style={{
                  background: index === 0 ? palette.blueSoft : palette.surface,
                  border: `1px solid ${index === 0 ? "rgba(47, 92, 216, 0.28)" : palette.line}`,
                  color: index === 0 ? palette.blue : palette.ink,
                  fontSize: 19,
                  fontWeight: 700,
                  opacity: featureEnter,
                  padding: "20px 24px",
                  transform: `translateY(${(1 - featureEnter) * 16}px)`,
                }}
              >
                {feature}
              </div>
            );
          })}
        </div>
      </ProductShot>
    </AbsoluteFill>
  );
}

function EndCard({ frame }: { frame: number }) {
  const enter = progress(frame, 410, 435);
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        opacity: sceneOpacity(frame, 408, DURATION_IN_FRAMES),
        textAlign: "center",
      }}
    >
      <div
        style={{
          opacity: enter,
          transform: `translateY(${(1 - enter) * 20}px)`,
          width: 1200,
        }}
      >
        <div style={{ fontSize: 84, fontWeight: 760, letterSpacing: "-0.05em" }}>Campfire</div>
        <div style={{ color: palette.blue, fontSize: 34, fontWeight: 650, marginTop: 18 }}>
          T3 Code, now multiplayer.
        </div>
        <div style={{ color: palette.muted, fontSize: 17, lineHeight: 1.5, marginTop: 52 }}>
          Open source · Built as a thin fork of T3 Code
          <br />
          Thanks to Theo Browne, Julius Marminge, the maintainers, and every upstream contributor.
        </div>
      </div>
    </AbsoluteFill>
  );
}

function CampfireLaunch() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: palette.paper,
        color: palette.ink,
        fontFamily,
        overflow: "hidden",
      }}
    >
      <Html5Audio
        src={staticFile("apps/marketing/video/campfire-soundtrack.m4a")}
        volume={(audioFrame) =>
          interpolate(
            audioFrame,
            [0, 18, DURATION_IN_FRAMES - 30, DURATION_IN_FRAMES],
            [0, 0.28, 0.28, 0],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            },
          )
        }
      />
      <Intro frame={frame} />
      <SharedSidebar frame={frame} />
      <TakeALook frame={frame} />
      <SharedControl frame={frame} />
      <TeamDiscussion frame={frame} />
      <MoreWorkflows frame={frame} />
      <EndCard frame={frame} />
    </AbsoluteFill>
  );
}

function RemotionRoot() {
  return (
    <Composition
      component={CampfireLaunch}
      durationInFrames={DURATION_IN_FRAMES}
      fps={FPS}
      height={1000}
      id="CampfireLaunch"
      width={1600}
    />
  );
}

registerRoot(RemotionRoot);
