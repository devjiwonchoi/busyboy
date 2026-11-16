'use client'

import '@xyflow/react/dist/style.css'
import { BaseEdge, Handle, Position, ReactFlow, type Dimensions, type Edge, type EdgeProps, type EdgeTypes, type NodeProps, type NodeTypes, type ReactFlowProps } from '@xyflow/react'
import { FolderGit2, GitBranch, ListTodo, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { GraphTask, GraphTodo, NodeStatus, ProjectGraph as Graph } from '@/server/records/project-graph'
import { BaseNode } from '@/components/base-node'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  layoutProjectGraph,
  todoLabel,
  type DisplayStatus,
  type GraphNode,
  type ProjectFlowNode,
  type TaskFlowNode,
  type TodoFlowNode,
} from './project-graph-layout'

const STATUS_LABELS: Record<DisplayStatus, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  done: 'Done',
  'not-started': 'Not started',
  stopped: 'Stopped',
  error: 'Could not read the records',
}

// Tinted border and fill per state, from the theme's status tokens: green = done, amber = in
// progress, blue = waiting on the user, muted = not started or stopped, red = unreadable records.
const PILL_TONE: Record<DisplayStatus, string> = {
  done: 'border-success/40 bg-success/10 text-success-foreground',
  running: 'border-warning/40 bg-warning/10 text-warning-foreground',
  'needs-you': 'border-info/50 bg-info/10 text-info-foreground',
  'not-started': 'border-border bg-muted text-muted-foreground',
  stopped: 'border-border bg-muted text-muted-foreground',
  error: 'border-destructive/50 bg-destructive/10 text-destructive',
}

/**
 * Read-only edges still need handles to attach to; they stay invisible. Tree edges leave a parent
 * from under its icon and enter a child from the left, which draws the elbow of an indented tree.
 */
function Handles({ buildsOn = false }: { buildsOn?: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0" />
      <Handle id="tree-out" type="source" position={Position.Bottom} isConnectable={false} className="opacity-0" style={{ left: 15 }} />
      {buildsOn && (
        <>
          <Handle id="builds-on-out" type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
          <Handle id="builds-on-in" type="target" position={Position.Right} isConnectable={false} className="opacity-0" />
        </>
      )}
    </>
  )
}

/** The compact node every level shares: icon and short label in a tinted, rounded pill. */
function Pill({
  icon: Icon,
  label,
  maxWidth,
  tone,
  status,
  dimmed,
  buildsOn,
}: {
  icon: LucideIcon
  label: string
  /** Widest the pill gets; a longer label is truncated and shown whole on hover. */
  maxWidth: string
  tone: string
  status?: string
  dimmed: boolean
  buildsOn?: boolean
}) {
  return (
    <BaseNode
      // The base node is a card; a pill keeps every level on one short row like the agreed design.
      className={cn(
        'flex h-7 w-fit items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-opacity',
        maxWidth,
        tone,
        dimmed && 'opacity-35',
      )}
    >
      <Handles buildsOn={buildsOn} />
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {/* The color carries the status for sighted users; this carries it for everyone else. */}
      {status && <span className="sr-only">, {status}</span>}
    </BaseNode>
  )
}

/** Key/value rows like the agreed design's hover card. */
function Details({ rows, label }: { rows: [string, React.ReactNode][]; label: string }) {
  return (
    <div role="group" aria-label={label}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground whitespace-nowrap">{key}</dt>
            {/* Paths have no spaces to break at, so they may break anywhere rather than overflow. */}
            <dd className="wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

const updatedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function taskRows(task: GraphTask): [string, React.ReactNode][] {
  const done = task.todos.filter(({ status }) => status === 'done').length
  const { passed, failed, pending } = task.checks
  const rows: [string, React.ReactNode][] = [['Task', task.title]]
  if (task.stage) rows.push(['Stage', task.stage])
  rows.push(['Status', STATUS_LABELS[task.status]])
  if (task.stateText) rows.push(['State', task.stateText])
  if (task.todos.length > 0) rows.push(['Todos', `${done} of ${task.todos.length} done`])
  if (passed + failed + pending > 0) rows.push(['Checks', `${passed} passed, ${failed} failed, ${pending} pending`])
  if (task.openFindings > 0) rows.push(['Review', `${task.openFindings} open ${task.openFindings === 1 ? 'finding' : 'findings'}`])
  if (task.buildsOn.length > 0) {
    rows.push(['Builds on', task.buildsOn.map(({ project, task, found }) => `${project}/${task}${found ? '' : ' (not found)'}`).join(', ')])
  }
  rows.push(['Branch', task.branch], ['Worktree', task.worktree], ['Updated', updatedFormat.format(new Date(task.updatedAt))])
  return rows
}

function todoRows(todo: GraphTodo, task: GraphTask): [string, React.ReactNode][] {
  const rows: [string, React.ReactNode][] = [['Todo', todoLabel(todo)]]
  if (task.stage) rows.push(['Stage', task.stage])
  rows.push(['Status', STATUS_LABELS[todo.status]])
  if (todo.goal) rows.push(['Goal', todo.goal])
  if (todo.resultText) rows.push(['Result', todo.resultText])
  rows.push(['Task', task.title], ['Worktree', task.worktree], ['Updated', updatedFormat.format(new Date(task.updatedAt))])
  return rows
}

function ProjectNode({ data }: NodeProps<ProjectFlowNode>) {
  const { name, empty, dimmed } = data
  return (
    <div className="flex h-full items-center gap-2">
      <Pill icon={FolderGit2} label={name} maxWidth="max-w-48" tone="border-border bg-card text-foreground" dimmed={dimmed} />
      {empty && <span className={cn('text-muted-foreground text-xs whitespace-nowrap transition-opacity', dimmed && 'opacity-35')}>No tasks yet</span>}
    </div>
  )
}

/**
 * The hover card for a node's details. It opens to the left, over the chat, so it never covers the
 * graph, and it is portaled out of the sidebar, so the sidebar's edges cannot cut it off. (React
 * Flow's NodeToolbar renders inside the graph's viewport, which clipped long details.)
 */
function NodeDetails({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={150} closeDelay={0} render={<div className="flex h-full items-center" />}>
        {trigger}
      </HoverCardTrigger>
      <HoverCardContent side="left" align="start" sideOffset={12} className="w-auto max-w-96">
        {children}
      </HoverCardContent>
    </HoverCard>
  )
}

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, status, dimmed } = data
  return (
    <NodeDetails
      trigger={
        <Pill
          icon={status === 'error' ? TriangleAlert : GitBranch}
          label={task.title}
          maxWidth="max-w-56"
          tone={PILL_TONE[status]}
          status={STATUS_LABELS[status]}
          dimmed={dimmed}
          buildsOn
        />
      }
    >
      {status === 'error' ? (
        <div className="space-y-1">
          <p className="font-medium">{task.title}</p>
          <ul className="space-y-1" aria-label="Record errors">
            {task.errors.map(({ file, message }) => (
              <li key={`${file}:${message}`}>
                {file}: {message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Details rows={taskRows(task)} label="Task details" />
      )}
    </NodeDetails>
  )
}

function TodoNode({ data }: NodeProps<TodoFlowNode>) {
  const { todo, task, dimmed } = data
  return (
    <NodeDetails
      trigger={
        <Pill icon={ListTodo} label={todoLabel(todo)} maxWidth="max-w-52" tone={PILL_TONE[todo.status]} status={STATUS_LABELS[todo.status]} dimmed={dimmed} />
      }
    >
      <Details rows={todoRows(todo, task)} label="Todo details" />
    </NodeDetails>
  )
}

const nodeTypes: NodeTypes = { project: ProjectNode, task: TaskNode, todo: TodoNode }

/**
 * Straight down from the parent, then across to the child: the square elbow of the agreed design.
 * React Flow's step edge turns halfway between the two ends instead, which adds a jog under the parent.
 */
function ElbowEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd }: EdgeProps) {
  return <BaseEdge id={id} path={`M ${sourceX},${sourceY} L ${sourceX},${targetY} L ${targetX},${targetY}`} style={style} markerEnd={markerEnd} />
}

const edgeTypes: EdgeTypes = { elbow: ElbowEdge }

function Count({ value, label }: { value: number; label: string }) {
  return (
    <span>
      <span className="text-foreground font-semibold tabular-nums">{value}</span> {label}
    </span>
  )
}

/** One line above the graph, like the agreed design: how much there is and what waits on the user. */
function Summary({ graph }: { graph: Graph }) {
  const tasks = graph.projects.flatMap(({ tasks }) => tasks)
  const count = (status: NodeStatus) => tasks.filter((task) => task.status === status && task.errors.length === 0).length
  const waiting = count('needs-you')
  const running = count('running')
  const todos = tasks.reduce((sum, task) => sum + (task.errors.length > 0 ? 0 : task.todos.length), 0)
  return (
    <p role="group" aria-label="Graph summary" className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 px-3 pt-3 pb-1 text-xs">
      <Count value={tasks.length} label={tasks.length === 1 ? 'task' : 'tasks'} />{' '}
      {waiting > 0 && <Count value={waiting} label="waiting" />}{' '}
      {running > 0 && <Count value={running} label="running" />}{' '}
      <Count value={todos} label={todos === 1 ? 'todo' : 'todos'} />
    </p>
  )
}

/**
 * The hovered node and its ancestors up to the project; the rest is dimmed. A hovered project
 * also keeps everything under it lit: dimming its own tasks dimmed nearly the whole graph around
 * one pill, which flashed as the pointer crossed the project row.
 */
function pathOf(id: string | null, parentOf: Map<string, string>) {
  if (!id) return null
  const path = new Set<string>()
  for (let node: string | undefined = id; node; node = parentOf.get(node)) path.add(node)
  const under = id.startsWith('project:') ? [id] : []
  while (under.length > 0) {
    const parent = under.pop()!
    for (const [child, of] of parentOf) {
      if (of === parent && !path.has(child)) {
        path.add(child)
        under.push(child)
      }
    }
  }
  return path
}

/**
 * Nodes sit a few pixels apart, so moving the pointer down the tree leaves one node before it
 * enters the next. Clearing the highlight right away lit the whole graph for that moment and
 * dimmed it again: the graph flickered. A leave waits this long for the next enter.
 */
const LEAVE_DELAY_MS = 120

function highlight(nodes: GraphNode[], edges: Edge[], path: Set<string> | null) {
  if (!path) return { nodes, edges }
  return {
    nodes: nodes.map((node) => {
      const dimmed = !path.has(node.id)
      return {
        ...node,
        data: { ...node.data, dimmed },
        domAttributes: { ...node.domAttributes, 'data-dimmed': String(dimmed) } as GraphNode['domAttributes'],
      } as GraphNode
    }),
    edges: edges.map((edge) => {
      const onPath = path.has(edge.source) && path.has(edge.target) && edge.className !== 'builds-on'
      return {
        ...edge,
        className: cn(edge.className, onPath ? 'on-path' : 'dimmed'),
        style: { ...edge.style, stroke: onPath ? 'var(--foreground)' : undefined, opacity: onPath ? 1 : 0.35 },
      }
    }),
  }
}

/**
 * React Flow, keeping the size it measured for each node. It hides a node until it knows the
 * node's size, and it takes a node object it has not seen as unmeasured. Hovering and every record
 * update build new node objects, so without this every node was hidden for a frame: the graph
 * flickered, and the pointer left the hovered node, which cancelled its hover card.
 */
function MeasuredFlow({ nodes, ...props }: ReactFlowProps<GraphNode, Edge> & { nodes: GraphNode[] }) {
  const [sizes, setSizes] = useState(() => new Map<string, Dimensions>())
  const measured = useMemo(
    () =>
      nodes.map((node) => {
        const size = sizes.get(node.id)
        return size ? { ...node, measured: size } : node
      }),
    [nodes, sizes],
  )
  return (
    <ReactFlow
      {...props}
      nodes={measured}
      onNodesChange={(changes) =>
        setSizes((current) => {
          let next = current
          for (const change of changes) {
            if (change.type !== 'dimensions' || !change.dimensions) continue
            if (next === current) next = new Map(current)
            next.set(change.id, change.dimensions)
          }
          return next
        })
      }
    />
  )
}

/** The Projects tab: every project's tasks and todos, live from their records. */
export function ProjectGraph() {
  const [graph, setGraph] = useState<Graph | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(leaveTimer.current), [])

  useEffect(() => {
    const source = new EventSource('/api/records/events')
    source.onmessage = (message) => setGraph(JSON.parse(message.data) as Graph)
    return () => source.close()
  }, [])

  const layout = useMemo(() => (graph ? layoutProjectGraph(graph) : null), [graph])
  const { nodes, edges } = useMemo(() => {
    if (!layout) return { nodes: [], edges: [] }
    // A node can vanish under the pointer when its record changes, and React fires no mouseleave
    // for it; lighting a missing id would dim the whole graph until the pointer found another node.
    const lit = hovered && layout.nodes.some((node) => node.id === hovered) ? hovered : null
    return highlight(layout.nodes, layout.edges, pathOf(lit, layout.parentOf))
  }, [layout, hovered])

  if (!graph) return null
  // The graph would be incomplete without the task list or settings, so say so instead of drawing it.
  if (graph.error) {
    return (
      <Alert variant="destructive" className="m-3 w-auto">
        <AlertDescription>{graph.error}</AlertDescription>
      </Alert>
    )
  }
  if (graph.projects.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>Add a project in Setup to see its tasks here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <section aria-label="Project graph" className="flex h-full min-h-80 flex-col">
      <Summary graph={graph} />
      <div className="min-h-0 flex-1">
        <MeasuredFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="system"
          // Edges in the theme's muted color on the sidebar's own background, instead of React Flow's grays.
          style={{ '--xy-edge-stroke': 'var(--muted-foreground)', '--xy-background-color': 'transparent' } as React.CSSProperties}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          // Start at the top-left at full size like the agreed design, instead of fitting a small
          // graph to the middle of the sidebar. Scrolling pans and pinching zooms, so a big graph
          // still fits by gesture without zoom buttons.
          defaultViewport={{ x: 12, y: 8, zoom: 1 }}
          minZoom={0.4}
          maxZoom={1.5}
          panOnScroll
          zoomOnScroll={false}
          // React Flow's MIT license does not require the attribution banner, which sat over the sidebar's corner.
          proOptions={{ hideAttribution: true }}
          onNodeMouseEnter={(_, node) => {
            clearTimeout(leaveTimer.current)
            setHovered(node.id)
          }}
          onNodeMouseLeave={() => {
            clearTimeout(leaveTimer.current)
            leaveTimer.current = setTimeout(() => setHovered(null), LEAVE_DELAY_MS)
          }}
        />
      </div>
    </section>
  )
}
