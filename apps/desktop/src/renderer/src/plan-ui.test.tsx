import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanBar from "./components/PlanBar.js";
import { useStore } from "./store.js";
beforeEach(() => useStore.setState({ currentTaskId: "plan-a", taskStatus:"running", planState:null, plan: null }));
afterEach(cleanup);
describe("compact task plan", () => {
  it("shows one current step and advances as the model updates the plan", () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: (i === 0 ? "in_progress" : "pending") as
        | "in_progress"
        | "pending"
        | "completed",
    }));
    useStore.setState({ plan: steps });
    const { container } = render(<PlanBar />);
    expect(container.querySelectorAll(".plan-step")).toHaveLength(1);
    expect(screen.getByText("step 1")).toBeTruthy();
    act(() =>
      useStore.setState({
        plan: steps.map((s, i) => ({
          ...s,
          status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
        })),
      }),
    );
    expect(screen.queryByText("step 1")).toBeNull();
    expect(screen.getByText("step 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看完整计划" }));
    expect(container.querySelectorAll(".plan-step")).toHaveLength(30);
    expect(container.querySelector(".plan-head ol")).toBeNull();
  });
  it("hides the entire plan when complete", () => {
    useStore.setState({ plan: [{ content: "verify", status: "in_progress" }] });
    render(<PlanBar />);
    fireEvent.click(screen.getByRole("button", { name: "查看完整计划" }));
    act(() =>
      useStore.setState({ plan: [{ content: "verify", status: "completed" }] }),
    );
    expect(screen.queryByText("verify")).toBeNull();
    expect(screen.queryByLabelText("任务计划")).toBeNull();
  });
  it("does not carry the expanded state into another task and marks pending work honestly", () => {
    useStore.setState({ plan: [{ content: "a", status: "in_progress" }] });
    render(<PlanBar />);
    fireEvent.click(screen.getByRole("button", { name: "查看完整计划" }));
    act(() =>
      useStore.setState({
        currentTaskId: "plan-b",
        plan: [
          { content: "b", status: "pending" },
          { content: "c", status: "pending" },
        ],
      }),
    );
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.queryByText("c")).toBeNull();
    expect(screen.getByText("待执行")).toBeTruthy();
  });
});

it.each(["cancelled", "error", "done"] as const)("collapses unfinished work when the task is %s", (status) => {
 useStore.setState({plan:[{content:"unfinished",status:"in_progress"}]});
 const {container}=render(<PlanBar />);
 fireEvent.click(screen.getByRole("button",{name:"查看完整计划"}));
 act(()=>useStore.setState({taskStatus:status}));
 if(status==="done"){expect(container.querySelector(".plan-bar")).toBeNull();return;}
 expect(screen.queryByText("unfinished")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"查看完整计划"}));
 expect(screen.getByText("unfinished")).toBeTruthy();
 expect(container.querySelector(".plan-step.in_progress")).toBeNull();
 expect(screen.getByText(status === "error" ? "计划执行失败" : "计划未完成")).toBeTruthy();
});

it("requires expanding the plan before approving its visible revision",async()=>{
 const call=vi.fn(async()=>({ok:true,result:{accepted:true}}));
 window.pih={invoke:call,onEvent:()=>()=>{},platform:"darwin",versions:{electron:"test",chrome:"test"}};
 useStore.setState({taskStatus:"done",plan:[{content:"reviewed step",status:"pending"}],planState:{revision:"rev-2",requiresApproval:true,status:"draft"}});
 render(<PlanBar />);
 expect(screen.queryByRole("button",{name:"批准并执行"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"查看完整计划"}));
 expect(screen.getByText("reviewed step")).toBeTruthy();
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"批准并执行"})));
 expect(call).toHaveBeenCalledWith("task:approvePlan",{taskId:"plan-a",revision:"rev-2"});
});
