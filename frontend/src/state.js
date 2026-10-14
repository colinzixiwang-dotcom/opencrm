// JSON may contain null for older Go nil slices. Keep rendering collections uniform.
const array = (value) => (Array.isArray(value) ? value : []);
const solution = (value) => ({
  ...value,
  nodes: array(value?.nodes).map((node) => ({
    ...node,
    dependsOn: array(node.dependsOn),
  })),
});
export function normalizeWorkspace(state) {
  const config = state.supportConfig || {};
  return {
    ...state,
    supportConfig: {
      ...config,
      solutions: array(config.solutions).map(solution),
      rootCauses: array(config.rootCauses).map((r) => ({
        ...r,
        productIds: array(r.productIds),
      })),
      fields: array(config.fields).map((f) => ({
        ...f,
        options: array(f.options),
      })),
      taskTypes: array(config.taskTypes),
      platforms: array(config.platforms),
      rules: array(config.rules),
    },
    rmas: array(state.rmas).map((r) => ({
      ...r,
      notes: array(r.notes),
      solutionSnapshot: solution(r.solutionSnapshot),
    })),
    rmaTasks: array(state.rmaTasks).map((t) => ({
      ...t,
      dependsOn: array(t.dependsOn),
      events: array(t.events),
      approvalReasons: array(t.approvalReasons),
    })),
    serials: array(state.serials),
    supportOrders: array(state.supportOrders),
    benefitHistory: array(state.benefitHistory),
  };
}
