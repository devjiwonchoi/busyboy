import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import type { GraphTask, GraphTodo, ProjectGraph } from '@/server/records/project-graph'

// Turns the project graph into React Flow nodes: one labeled group per
// project, laid out left to right by dagre inside it (task → todos), groups
// stacked top to bottom, and dashed edges for "builds on" links between tasks.

export const TASK_SIZE = { width: 220, height: 64 }
export const TODO_SIZE = { width: 200, height: 44 }
const EMPTY_SIZE = { width: 220, height: 40 }
/** Room for the group's label above its nodes. */
const GROUP_PADDING = { top: 44, side: 16, bottom: 16 }
const GROUP_GAP = 32

export type ProjectNodeData = { name: string; empty: boolean }
export type TaskNodeData = { task: GraphTask }
export type TodoNodeData = { todo: GraphTodo; task: GraphTask }

export type ProjectFlowNode = Node<ProjectNodeData, 'project'>
export type TaskFlowNode = Node<TaskNodeData, 'task'>
export type TodoFlowNode = Node<TodoNodeData, 'todo'>
export type GraphNode = ProjectFlowNode | TaskFlowNode | TodoFlowNode

export const projectNodeId = (name: string) => `project:${name}`
export const taskNodeId = (project: string, task: string) => `task:${project}/${task}`
const todoNodeId = (project: string, task: string, todo: string) => `todo:${project}/${task}/${todo}`

export function layoutProjectGraph(graph: ProjectGraph): { nodes: GraphNode[]; edges: Edge[] } {
  const nodes: GraphNode[] = []
  const edges: Edge[] = []
  let top = 0
  let widest = 0
  const groups: ProjectFlowNode[] = []

  for (const project of graph.projects) {
    const layout = new dagre.graphlib.Graph()
    layout.setGraph({ rankdir: 'LR', nodesep: 12, ranksep: 40, marginx: 0, marginy: 0 })
    layout.setDefaultEdgeLabel(() => ({}))
    const children: GraphNode[] = []

    for (const task of project.tasks) {
      const id = taskNodeId(project.name, task.id)
      layout.setNode(id, { ...TASK_SIZE })
      // The status is also on the DOM node, so it can be read without relying on color.
      const status = task.errors.length > 0 ? 'error' : task.status
      children.push({
        id,
        type: 'task',
        position: { x: 0, y: 0 },
        data: { task },
        ariaLabel: `Task ${task.title}`,
        domAttributes: { 'data-status': status } as Node['domAttributes'],
        ...TASK_SIZE,
      })
      // An error node stands alone: todos from a record that did not parse could be wrong.
      if (task.errors.length > 0) continue
      for (const todo of task.todos) {
        const todoId = todoNodeId(project.name, task.id, todo.id)
        layout.setNode(todoId, { ...TODO_SIZE })
        layout.setEdge(id, todoId)
        children.push({
          id: todoId,
          type: 'todo',
          position: { x: 0, y: 0 },
          data: { todo, task },
          ariaLabel: `Todo ${todo.id} · ${todo.title}`,
          domAttributes: { 'data-status': todo.status } as Node['domAttributes'],
          ...TODO_SIZE,
        })
        edges.push({ id: `${id}->${todoId}`, source: id, target: todoId })
      }
    }

    let width = EMPTY_SIZE.width
    let height = EMPTY_SIZE.height
    if (children.length > 0) {
      dagre.layout(layout)
      const size = layout.graph()
      width = size.width ?? 0
      height = size.height ?? 0
      for (const child of children) {
        // dagre gives centers; React Flow wants top-left corners relative to the group.
        const { x, y } = layout.node(child.id)
        child.position = {
          x: GROUP_PADDING.side + x - (child.width ?? 0) / 2,
          y: GROUP_PADDING.top + y - (child.height ?? 0) / 2,
        }
        child.parentId = projectNodeId(project.name)
        child.extent = 'parent'
      }
      // dagre may stack a task's todos in any order; put them back in record order, top to bottom.
      for (const task of project.tasks) {
        const todos = children.filter((child) => child.type === 'todo' && child.data.task.id === task.id)
        const slots = todos.map(({ position }) => position.y).sort((a, b) => a - b)
        todos.forEach((todo, index) => (todo.position = { ...todo.position, y: slots[index] }))
      }
    }
    const group: ProjectFlowNode = {
      id: projectNodeId(project.name),
      type: 'project',
      position: { x: 0, y: top },
      data: { name: project.name, empty: children.length === 0 },
      ariaLabel: `Project ${project.name}`,
      width: width + GROUP_PADDING.side * 2,
      height: height + GROUP_PADDING.top + GROUP_PADDING.bottom,
      selectable: false,
    }
    groups.push(group)
    widest = Math.max(widest, group.width ?? 0)
    // React Flow needs a parent before its children in the list.
    nodes.push(group, ...children)
    top += (group.height ?? 0) + GROUP_GAP
  }
  // Same width for every group, so the stack reads as one column.
  for (const group of groups) group.width = widest

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
          label: 'builds on',
          style: { strokeDasharray: '6 4' },
          className: 'builds-on',
        })
      }
    }
  }
  return { nodes, edges }
}
