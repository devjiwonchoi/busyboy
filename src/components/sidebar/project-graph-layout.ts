import type { Edge, Node } from '@xyflow/react'
import type { GraphTask, GraphTodo, NodeStatus, ProjectGraph } from '@/server/records/project-graph'

// Turns the project graph into React Flow nodes: per project an indented tree
// of pills (project → tasks → todos), one pill per row, each level a step to
// the right of its parent, with elbow edges from a parent's bottom to its
// children's left side. A column per level pushed todos past the edge of a
// 20rem sidebar; indented rows keep the whole tree readable at sidebar width
// while still reading left to right. Projects stack top to bottom. Dashed
// edges mark either a tree child that has not started yet or a task that
// builds on another.

const ROW_HEIGHT = 36
/** How far each level sits to the right of its parent. */
const INDENT = 24
const PROJECT_GAP = 12

export type DisplayStatus = NodeStatus | 'error'

export type ProjectNodeData = { name: string; empty: boolean; dimmed: boolean }
export type TaskNodeData = { task: GraphTask; status: DisplayStatus; dimmed: boolean }
export type TodoNodeData = { todo: GraphTodo; task: GraphTask; dimmed: boolean }

export type ProjectFlowNode = Node<ProjectNodeData, 'project'>
export type TaskFlowNode = Node<TaskNodeData, 'task'>
export type TodoFlowNode = Node<TodoNodeData, 'todo'>
export type GraphNode = ProjectFlowNode | TaskFlowNode | TodoFlowNode

export const projectNodeId = (name: string) => `project:${name}`
export const taskNodeId = (project: string, task: string) => `task:${project}/${task}`
const todoNodeId = (project: string, task: string, todo: string) => `todo:${project}/${task}/${todo}`

export const todoLabel = (todo: GraphTodo) => `${todo.id} · ${todo.title}`

export type ProjectGraphLayout = {
  nodes: GraphNode[]
  edges: Edge[]
  /** Each node's parent in the tree, for highlighting a node's path back to its project. */
  parentOf: Map<string, string>
}

export function layoutProjectGraph(graph: ProjectGraph): ProjectGraphLayout {
  const nodes: GraphNode[] = []
  const edges: Edge[] = []
  const parentOf = new Map<string, string>()
  let row = 0
  let gaps = 0
  // Nodes are sized by their content (React Flow measures them), so only rows and levels are placed here.
  const at = (level: number) => ({ x: level * INDENT, y: row++ * ROW_HEIGHT + gaps * PROJECT_GAP })

  for (const project of graph.projects) {
    const rootId = projectNodeId(project.name)
    nodes.push({
      id: rootId,
      type: 'project',
      position: at(0),
      data: { name: project.name, empty: project.tasks.length === 0, dimmed: false },
      ariaLabel: `Project ${project.name}`,
      selectable: false,
    })
    for (const task of project.tasks) {
      const id = taskNodeId(project.name, task.id)
      // The status is also on the DOM node, so it can be read without relying on color.
      const status: DisplayStatus = task.errors.length > 0 ? 'error' : task.status
      nodes.push({
        id,
        type: 'task',
        position: at(1),
        data: { task, status, dimmed: false },
        ariaLabel: `Task ${task.title}`,
        domAttributes: { 'data-status': status } as Node['domAttributes'],
        // A task's pill is a toggle that selects it for the terminal. A press on the pane starts
        // a pan, which swallows the click, so task nodes opt out of panning.
        className: 'nopan',
      })
      parentOf.set(id, rootId)
      edges.push(treeEdge(rootId, id, status))
      // An error node stands alone: todos from a record that did not parse could be wrong.
      if (status === 'error') continue
      for (const todo of task.todos) {
        const todoId = todoNodeId(project.name, task.id, todo.id)
        nodes.push({
          id: todoId,
          type: 'todo',
          position: at(2),
          data: { todo, task, dimmed: false },
          ariaLabel: `Todo ${todoLabel(todo)}`,
          domAttributes: { 'data-status': todo.status } as Node['domAttributes'],
        })
        parentOf.set(todoId, id)
        edges.push(treeEdge(id, todoId, todo.status))
      }
    }
    gaps++
  }

  const known = new Set(nodes.map(({ id }) => id))
  for (const project of graph.projects) {
    for (const task of project.tasks) {
      for (const base of task.buildsOn) {
        const source = taskNodeId(base.project, base.task)
        const target = taskNodeId(project.name, task.id)
        if (!known.has(source)) continue
        edges.push({
          id: `builds-on:${source}->${target}`,
          source,
          target,
          // Both ends on the right, so the link loops beside the trees instead of crossing them.
          sourceHandle: 'builds-on-out',
          targetHandle: 'builds-on-in',
          label: 'builds on',
          style: { strokeDasharray: '6 4' },
          className: 'builds-on',
        })
      }
    }
  }
  return { nodes, edges, parentOf }
}

/** An elbow down from the parent and across to the child: solid once the child has started, dashed while it waits. */
function treeEdge(source: string, target: string, status: DisplayStatus): Edge {
  const pending = status === 'not-started'
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: 'tree-out',
    type: 'elbow',
    className: pending ? 'pending' : 'active',
    style: pending ? { strokeDasharray: '4 3' } : undefined,
  }
}
