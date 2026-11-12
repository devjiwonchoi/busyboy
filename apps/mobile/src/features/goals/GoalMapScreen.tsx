import {
  buildGoalMap,
  GOAL_MAP_LAYOUT,
  type GoalMap,
  type GoalMapGoal,
  type GoalMapTask,
} from "@t3tools/shared/goalMap";
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, Line, Marker, Path } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useEnvironments } from "../../state/environments";
import { useProjectManagerEntries } from "../../state/projectTeam";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useHomeThreadSelection } from "../home/home-thread-navigation";
import {
  compactNextAction,
  GOAL_MAP_TASK_LABEL_SIZE,
  GOAL_MAP_ZOOM_ALL,
  goalMapThreadTarget,
  goalMapTransform,
  goalTextMetrics,
  goalTextScale,
  showGoalMapTaskLabels,
  type GoalMapZoom,
} from "./goal-map";

const L = GOAL_MAP_LAYOUT;
const USER_TURN_COLOR = "#eab308";
const USER_TURN_TEXT = "#422006";
const RUNNING_COLOR = "#3b82f6";
const DONE_COLOR = "#10b981";
const ZOOM_TIMING = { duration: 320, reduceMotion: ReduceMotion.System };

type Colors = {
  foreground: string;
  muted: string;
  card: string;
  border: string;
  danger: string;
  waiting: string;
};

function statusColor(status: GoalMapTask["status"], colors: Colors) {
  switch (status) {
    case "user":
      return USER_TURN_COLOR;
    case "running":
      return RUNNING_COLOR;
    case "blocked":
      return colors.danger;
    case "waiting":
      return colors.waiting;
  }
}

/** Shortens a segment between two circles so the arrow ends on the target's edge. */
function edgePath(
  from: { x: number; y: number; r: number },
  to: { x: number; y: number; r: number },
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= from.r + to.r + 4) {
    return null;
  }
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: from.x + ux * from.r,
    y1: from.y + uy * from.r,
    x2: to.x - ux * (to.r + 4),
    y2: to.y - uy * (to.r + 4),
  };
}

function GoalMapGraphic({ map, colors }: { map: GoalMap; colors: Colors }) {
  const { layout } = map;
  const taskPositions = layout.taskPos;
  return (
    <Svg width={layout.width} height={layout.height} pointerEvents="none">
      <Defs>
        <Marker
          id="goal-map-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <Path d="M0,0 L10,5 L0,10 z" fill={colors.danger} />
        </Marker>
      </Defs>
      {map.goals.map((goal) => {
        const center = layout.goalPos[goal.id]!;
        return goal.tasks.map((task) => {
          const position = taskPositions[task.nodeId];
          return position === undefined ? null : (
            <Line
              key={`spoke:${task.nodeId}`}
              x1={center.x}
              y1={center.y}
              x2={position.x}
              y2={position.y}
              stroke={colors.border}
              strokeWidth={1}
            />
          );
        });
      })}
      {map.edges.map((edge) => {
        const from = taskPositions[edge.fromTaskNodeId];
        const to = taskPositions[edge.toTaskNodeId];
        const segment = from && to ? edgePath(from, to) : null;
        return segment === null ? null : (
          <Line
            key={edge.id}
            {...segment}
            stroke={colors.danger}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            markerEnd="url(#goal-map-arrow)"
          />
        );
      })}
      {map.goals.map((goal) => {
        const center = layout.goalPos[goal.id]!;
        return (
          <Circle
            key={goal.id}
            cx={center.x}
            cy={center.y}
            r={center.r}
            fill={colors.card}
            stroke={goal.none ? colors.muted : colors.foreground}
            strokeWidth={2}
            strokeDasharray={goal.none ? "6 5" : undefined}
          />
        );
      })}
      {map.goals.flatMap((goal) =>
        (layout.dotPos[goal.id] ?? []).map((dot, index) => (
          <Circle
            key={`dot:${goal.id}:${index}`}
            cx={dot.x}
            cy={dot.y}
            r={dot.r}
            fill={DONE_COLOR}
          />
        )),
      )}
      {map.goals.flatMap((goal) =>
        goal.tasks.map((task) => {
          const position = taskPositions[task.nodeId];
          return position === undefined ? null : (
            <Circle
              key={task.nodeId}
              cx={position.x}
              cy={position.y}
              r={position.r}
              fill={statusColor(task.status, colors)}
              stroke={colors.card}
              strokeWidth={2}
            />
          );
        }),
      )}
    </Svg>
  );
}

function UserTurnTag(props: { readonly label: string; readonly fontSize: number }) {
  return (
    <View className="rounded-full px-1.5" style={{ backgroundColor: USER_TURN_COLOR }}>
      <Text style={{ color: USER_TURN_TEXT, fontSize: props.fontSize }} className="font-t3-bold">
        {props.label}
      </Text>
    </View>
  );
}

/**
 * The goal's count, "+N" and its text block under it. `textScale` scales the text block up
 * so the overview stays readable; it keeps the layout's text width and stays in the cell.
 */
function GoalLabels(props: {
  readonly goal: GoalMapGoal;
  readonly map: GoalMap;
  readonly textScale: number;
  readonly compact: boolean;
  readonly onPressGoal: (goalId: string) => void;
}) {
  const { goal, map } = props;
  const center = map.layout.goalPos[goal.id]!;
  const text = map.layout.textPos[goal.id]!;
  const overflow = map.layout.overflowPos[goal.id]!;
  const { counts, nextAction } = goal;
  const total = counts.done + counts.remaining;
  const userTurn = nextAction.kind === "user";
  const m = goalTextMetrics(props.textScale);
  const actionText = props.compact ? compactNextAction(nextAction) : nextAction.text;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${goal.title}, 남은 ${counts.remaining}, 완료 ${counts.done}`}
        accessibilityHint="이 목표로 확대"
        onPress={() => props.onPressGoal(goal.id)}
        className="absolute items-center justify-center rounded-full"
        style={{
          left: center.x - center.r,
          top: center.y - center.r,
          width: center.r * 2,
          height: center.r * 2,
        }}
      >
        <Text
          numberOfLines={1}
          className="font-t3-bold text-foreground"
          style={{ fontSize: 15, fontVariant: ["tabular-nums"] }}
        >
          {`${counts.done}/${total}`}
        </Text>
      </Pressable>
      {goal.overflow > 0 ? (
        <Text
          className="absolute text-foreground-muted"
          style={{ left: overflow.x - 10, top: overflow.y - 10, fontSize: 16 }}
        >
          +{goal.overflow}
        </Text>
      ) : null}
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => props.onPressGoal(goal.id)}
        className="absolute overflow-hidden"
        style={{ left: text.x, top: text.y, width: text.width, height: m.height }}
      >
        <Text
          numberOfLines={1}
          className={goal.none ? "font-t3-bold text-foreground-muted" : "font-t3-bold"}
          style={{ fontSize: m.titleSize, lineHeight: m.titleLine, height: m.titleLine }}
        >
          {goal.title}
        </Text>
        <Text
          numberOfLines={1}
          className="text-foreground-muted"
          style={{
            marginTop: m.countsGap,
            fontSize: m.smallSize,
            lineHeight: m.smallLine,
            height: m.smallLine,
          }}
        >
          남은 {counts.remaining} · 완료 {counts.done}
          {goal.hiddenDone > 0 ? ` (점 외 ${goal.hiddenDone})` : ""}
        </Text>
        <View
          className="flex-row items-center"
          style={{ marginTop: m.actionGap, height: m.actionHeight }}
        >
          {userTurn ? (
            <View
              className="shrink justify-center"
              style={{
                backgroundColor: USER_TURN_COLOR,
                height: m.actionHeight,
                borderRadius: m.actionHeight / 2,
                paddingHorizontal: m.actionPad,
              }}
            >
              <Text
                numberOfLines={1}
                style={{ color: USER_TURN_TEXT, fontSize: m.smallSize, lineHeight: m.smallLine }}
              >
                {actionText}
              </Text>
            </View>
          ) : (
            <Text
              numberOfLines={1}
              className={
                nextAction.kind === "blocked"
                  ? "shrink text-danger"
                  : "shrink text-foreground-secondary"
              }
              style={{ fontSize: m.smallSize, lineHeight: m.smallLine }}
            >
              {actionText}
            </Text>
          )}
        </View>
      </Pressable>
    </>
  );
}

function TaskNode(props: {
  readonly task: GoalMapTask;
  readonly map: GoalMap;
  readonly showLabel: boolean;
  readonly onOpen: (task: GoalMapTask) => void;
}) {
  const { task } = props;
  const position = props.map.layout.taskPos[task.nodeId];
  if (position === undefined) {
    return null;
  }
  const hit = L.taskHitRadius;
  const target = goalMapThreadTarget(task);
  const content = props.showLabel ? (
    <>
      {task.userTurn !== null ? (
        <View className="absolute items-center" style={{ top: -14, left: -16, right: -16 }}>
          <UserTurnTag label="내 차례" fontSize={9} />
        </View>
      ) : null}
      <Text
        numberOfLines={1}
        className="absolute text-center text-foreground"
        style={{ bottom: -4, left: -20, right: -20, fontSize: GOAL_MAP_TASK_LABEL_SIZE }}
      >
        {task.key}
      </Text>
    </>
  ) : null;
  const frame = {
    left: position.x - hit,
    top: position.y - hit,
    width: hit * 2,
    height: hit * 2,
  };
  const label = `${task.key} ${task.title}${task.userTurn !== null ? `, 내 차례 ${task.userTurn.label}` : ""}`;
  return target === null ? (
    <View accessible accessibilityLabel={label} className="absolute" style={frame}>
      {content}
    </View>
  ) : (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint="리드 스레드 열기"
      onPress={() => props.onOpen(task)}
      className="absolute"
      style={frame}
    >
      {content}
    </Pressable>
  );
}

export function GoalMapScreen() {
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const markdownStyles = useMarkdownPreviewStyles();
  const selectThread = useHomeThreadSelection();
  const { environments } = useEnvironments();
  const entries = useProjectManagerEntries(
    environments.map((environment) => environment.environmentId),
  );
  const map = useMemo(() => buildGoalMap({ entries }), [entries]);
  const colors: Colors = {
    foreground: theme["--color-foreground"],
    muted: theme["--color-foreground-muted"],
    card: theme["--color-card"],
    border: theme["--color-border"],
    danger: theme["--color-danger"],
    waiting: theme["--color-foreground-tertiary"],
  };

  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<GoalMapZoom>(GOAL_MAP_ZOOM_ALL);
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const animate = useRef(false);

  // A goal that left the map falls back to the whole map.
  const effectiveZoom =
    zoom.kind === "goal" && map.layout.cells[zoom.goalId] === undefined ? GOAL_MAP_ZOOM_ALL : zoom;
  const target = useMemo(
    () =>
      viewport.width === 0 || viewport.height === 0
        ? null
        : goalMapTransform(map.layout, effectiveZoom, viewport),
    [map.layout, effectiveZoom, viewport],
  );
  // Text and labels follow where the zoom is headed, not each animation frame.
  const targetScale = target?.scale ?? 1;
  const textScale = goalTextScale(targetScale);
  const showTaskLabels = showGoalMapTaskLabels(effectiveZoom, targetScale);
  // The phone overview: too small for task labels, so the next action shortens too.
  const compact = effectiveZoom.kind === "all" && !showTaskLabels;

  useEffect(() => {
    if (target === null) {
      return;
    }
    const next = target;
    // RN scales around the view's center; convert from the top-left based map transform.
    const x = next.x - (map.layout.width / 2) * (1 - next.scale);
    const y = next.y - (map.layout.height / 2) * (1 - next.scale);
    if (animate.current) {
      scale.value = withTiming(next.scale, ZOOM_TIMING);
      translateX.value = withTiming(x, ZOOM_TIMING);
      translateY.value = withTiming(y, ZOOM_TIMING);
    } else {
      scale.value = next.scale;
      translateX.value = x;
      translateY.value = y;
    }
    animate.current = false;
  }, [map.layout, target, scale, translateX, translateY]);

  const changeZoom = (next: GoalMapZoom) => {
    animate.current = true;
    setZoom(next);
  };

  const mapStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  };

  const openTask = (task: GoalMapTask) => {
    const target = goalMapThreadTarget(task);
    if (target !== null) {
      selectThread(target);
    }
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
      {map.briefing !== null ? (
        <ScrollView
          style={{ maxHeight: 160, flexGrow: 0 }}
          contentContainerClassName="gap-1 px-4 pt-3 pb-2"
        >
          <Text className="text-xs text-foreground-muted">디렉터</Text>
          <SelectableMarkdownText
            markdown={map.briefing}
            textStyle={markdownStyles.nativeTextStyle}
            onLinkPress={(href) => void Linking.openURL(href)}
          />
        </ScrollView>
      ) : null}
      <View className="flex-1 overflow-hidden" onLayout={onLayout}>
        {map.goals.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-center text-sm text-foreground-muted">
              아직 목표가 없어요. 디렉터에게 목표를 말해 보세요.
            </Text>
          </View>
        ) : (
          <Reanimated.View
            className="absolute left-0 top-0"
            style={[{ width: map.layout.width, height: map.layout.height }, mapStyle]}
          >
            <GoalMapGraphic map={map} colors={colors} />
            {map.goals.map((goal) => (
              <GoalLabels
                key={goal.id}
                goal={goal}
                map={map}
                textScale={textScale}
                compact={compact}
                onPressGoal={(id) => changeZoom({ kind: "goal", goalId: id })}
              />
            ))}
            {map.goals.flatMap((goal) =>
              goal.tasks.map((task) => (
                <TaskNode
                  key={task.nodeId}
                  task={task}
                  map={map}
                  showLabel={showTaskLabels}
                  onOpen={openTask}
                />
              )),
            )}
          </Reanimated.View>
        )}
        {effectiveZoom.kind === "goal" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => changeZoom(GOAL_MAP_ZOOM_ALL)}
            className="absolute right-4 top-3 rounded-full border border-border bg-card px-3 py-1.5"
          >
            <Text className="text-sm font-t3-bold text-foreground">전체 보기</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
