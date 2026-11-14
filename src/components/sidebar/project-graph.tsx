'use client'

import '@xyflow/react/dist/style.css'
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps, type NodeTypes } from '@xyflow/react'
import { TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { GraphTask, NodeStatus, ProjectGraph as Graph } from '@/server/records/project-graph'
import { BaseNode, BaseNodeContent, BaseNodeHeader, BaseNodeHeaderTitle } from '@/components/base-node'
import { GroupNode } from '@/components/labeled-group-node'
import { NodeStatusIndicator, type NodeStatus as IndicatorStatus } from '@/components/node-status-indicator'
import { NodeTooltip, NodeTooltipContent, NodeTooltipTrigger } from '@/components/node-tooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { layoutProjectGraph, type ProjectFlowNode, type TaskFlowNode, type TodoFlowNode } from './project-graph-layout'

const STATUS_LABELS: Record<NodeStatus, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  done: 'Done',
  'not-started': 'Not started',
  stopped: 'Stopped',
}

// amber = needs you, blue = running (animated border), green = done, gray = not started, red = stopped.
const INDICATOR: Record<NodeStatus, IndicatorStatus> = {
  'needs-you': 'warning',
  running: 'loading',
  done: 'success',
  'not-started': 'initial',
  stopped: 'error',
}

const DOT: Record<NodeStatus, string> = {
  'needs-you': 'bg-amber-500',
  running: 'bg-blue-600',
  done: 'bg-emerald-600',
  'not-started': 'bg-muted-foreground/40',
  stopped: 'bg-red-500',
}

function StatusLine({ status }: { status: NodeStatus }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <span aria-hidden className={cn('size-2 rounded-full', DOT[status])} />
      {STATUS_LABELS[status]}
    </span>
  )
}

const handles = (
  <>
    {/* Edges need handles; the graph is read-only, so they stay invisible. */}
    <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0" />
    <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
  </>
)

function ProjectNode({ data }: NodeProps<ProjectFlowNode>) {
  const { name, empty } = data
  return (
    <>
      <GroupNode label={name} position="top-left" />
      {empty && <p className="text-muted-foreground absolute inset-x-4 bottom-4 text-xs">No tasks yet.</p>}
    </>
  )
}

function TaskDetails({ task }: { task: GraphTask }) {
  const done = task.todos.filter(({ status }) => status === 'done').length
  const { passed, failed, pending } = task.checks
  return (
    <div className="max-w-72 space-y-1.5 text-xs">
      {/* The node truncates long titles; the details show it whole. */}
      <p className="font-medium">{task.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Branch</dt>
        <dd className="truncate">{task.branch}</dd>
        {task.stage && (
          <>
            <dt>Stage</dt>
            <dd>{task.stage}</dd>
          </>
        )}
        {task.stateText && (
          <>
            <dt>State</dt>
            <dd>{task.stateText}</dd>
          </>
        )}
        {task.todos.length > 0 && (
          <>
            <dt>Todos</dt>
            <dd>
              {done} of {task.todos.length} done
            </dd>
          </>
        )}
        {passed + failed + pending > 0 && (
          <>
            <dt>Checks</dt>
            <dd>
              {passed} passed, {failed} failed, {pending} pending
            </dd>
          </>
        )}
        {task.openFindings > 0 && (
          <>
            <dt>Review</dt>
            <dd>
              {task.openFindings} open {task.openFindings === 1 ? 'finding' : 'findings'}
            </dd>
          </>
        )}
        {task.buildsOn.length > 0 && (
          <>
            <dt>Builds on</dt>
            <dd>
              {task.buildsOn.map(({ project, task, found }) => `${project}/${task}${found ? '' : ' (not found)'}`).join(', ')}
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task } = data
  if (task.errors.length > 0) {
    return (
      <NodeTooltip>
        <NodeTooltipTrigger>
          <NodeStatusIndicator status="error">
            <BaseNode className="bg-destructive/10 h-16 w-[220px]">
              {handles}
              <BaseNodeHeader className="py-1.5">
                <TriangleAlert aria-hidden className="text-destructive size-4" />
                <BaseNodeHeaderTitle className="truncate text-sm">{task.title}</BaseNodeHeaderTitle>
              </BaseNodeHeader>
              <BaseNodeContent className="py-0">
                <span className="text-destructive text-xs">Could not read the records</span>
              </BaseNodeContent>
            </BaseNode>
          </NodeStatusIndicator>
        </NodeTooltipTrigger>
        <NodeTooltipContent position={Position.Top} align="start">
          <ul className="max-w-72 space-y-1 text-xs" aria-label="Record errors">
            {task.errors.map(({ file, message }) => (
              <li key={`${file}:${message}`}>
                {file}: {message}
              </li>
            ))}
          </ul>
        </NodeTooltipContent>
      </NodeTooltip>
    )
  }
  return (
    <NodeTooltip>
      <NodeTooltipTrigger>
        <NodeStatusIndicator status={INDICATOR[task.status]}>
          <BaseNode className="h-16 w-[220px]">
            {handles}
            <BaseNodeHeader className="py-1.5">
              <BaseNodeHeaderTitle className="truncate text-sm">{task.title}</BaseNodeHeaderTitle>
            </BaseNodeHeader>
            <BaseNodeContent className="py-0">
              <StatusLine status={task.status} />
            </BaseNodeContent>
          </BaseNode>
        </NodeStatusIndicator>
      </NodeTooltipTrigger>
      <NodeTooltipContent position={Position.Top} align="start">
        <TaskDetails task={task} />
      </NodeTooltipContent>
    </NodeTooltip>
  )
}

function TodoNode({ data }: NodeProps<TodoFlowNode>) {
  const { todo } = data
  return (
    <NodeTooltip>
      <NodeTooltipTrigger>
        <NodeStatusIndicator status={INDICATOR[todo.status]}>
          <BaseNode className="flex h-11 w-[200px] flex-col justify-center gap-0.5 px-3">
            {handles}
            <span className="truncate text-xs font-medium">
              {todo.id} · {todo.title}
            </span>
            <StatusLine status={todo.status} />
          </BaseNode>
        </NodeStatusIndicator>
      </NodeTooltipTrigger>
      {(todo.goal || todo.resultText) && (
        <NodeTooltipContent position={Position.Top} align="start">
          <div className="max-w-72 space-y-1 text-xs">
            {todo.goal && <p>{todo.goal}</p>}
            {todo.resultText && <p>Result: {todo.resultText}</p>}
          </div>
        </NodeTooltipContent>
      )}
    </NodeTooltip>
  )
}

const nodeTypes: NodeTypes = { project: ProjectNode, task: TaskNode, todo: TodoNode }

/** The Projects tab: every project's tasks and todos, live from their records. */
export function ProjectGraph() {
  const [graph, setGraph] = useState<Graph | null>(null)

  useEffect(() => {
    const source = new EventSource('/api/records/events')
    source.onmessage = (message) => setGraph(JSON.parse(message.data) as Graph)
    return () => source.close()
  }, [])

  const { nodes, edges } = useMemo(() => (graph ? layoutProjectGraph(graph) : { nodes: [], edges: [] }), [graph])
  // fitView runs on mount only, so a new set of nodes remounts the view to fit them; status changes keep the view.
  const shape = useMemo(() => nodes.map(({ id }) => id).join('\n'), [nodes])

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
    <section aria-label="Project graph" className="h-full min-h-80">
      <ReactFlow
        key={shape}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="system"
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  )
}
