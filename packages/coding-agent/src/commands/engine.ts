import { join } from "node:path";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { restoreLifecycleTerminal, writeLifecyclePresentation } from "../breadboard/lifecycle/lifecycle-presenter";
import { type LifecycleResult, lifecycleFailure, lifecycleState } from "../breadboard/lifecycle/lifecycle-state";
import {
	dispatchLifecycleAction,
	type LifecycleActionExecution,
	LifecycleSupervisor,
} from "../breadboard/lifecycle/lifecycle-supervisor";
import { LocalAuthorityStore } from "../breadboard/lifecycle/local-authority-store";
import {
	BREADBOARD_ENGINE_MODES,
	BreadboardRunConfigError,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "../breadboard/lifecycle/run-config";
import { Settings } from "../config/settings";

const ENGINE_ACTIONS = ["start", "status", "stop", "restart"] as const;
type EngineAction = (typeof ENGINE_ACTIONS)[number];

export default class Engine extends Command {
	static description = "Manage the governed BreadBoard engine lifecycle";

	static args = {
		action: Args.string({
			description: "Lifecycle action",
			required: false,
			options: [...ENGINE_ACTIONS],
		}),
	};

	static flags = {
		"engine-mode": Flags.string({
			description: "BreadBoard engine mode",
			options: [...BREADBOARD_ENGINE_MODES],
		}),
		"engine-url": Flags.string({ description: "Exact BreadBoard engine endpoint URL" }),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	async run(): Promise<void> {
		let terminalOwnedByDispatch = false;
		try {
			const { args, flags } = await this.parse(Engine);
			const action = (args.action ?? "status") as EngineAction;
			const activeSettings = await Settings.init({ cwd: process.cwd(), configFiles: flags.config });
			const selectedConfig = parseSelectedBreadboardConfig(activeSettings.getRaw("breadboard"));
			const config = resolveBreadboardRunConfig({
				cli: {
					engineMode: flags["engine-mode"],
					engineUrl: flags["engine-url"],
				},
				derivedOwnerExitPolicy: action === "start" || action === "restart" ? "detached" : "attached",
				selectedConfig,
				workspacePath: process.cwd(),
			});
			let execution: LifecycleActionExecution;
			if (config.mode === "off") {
				const result: LifecycleResult =
					action === "status"
						? {
								kind: "off",
								state: lifecycleState("off", "off", 0, "engine_mode_off") as LifecycleResult & never,
							}
						: lifecycleFailure("off", "failed", "mode_forbidden");
				execution = { result };
			} else {
				const store =
					config.mode === "local-owned"
						? new LocalAuthorityStore(join(getAgentDir(), "breadboard", "lifecycle"))
						: undefined;
				const supervisor = new LifecycleSupervisor(config, { ...(store === undefined ? {} : { store }) });
				terminalOwnedByDispatch = true;
				execution = await dispatchLifecycleAction(supervisor, action, {
					actionOptions: { consumerClosed: true, explicit: action === "stop" || action === "restart" },
					closeReady: action === "start" || action === "restart" || action === "status",
					restoreTerminal: restoreLifecycleTerminal,
				});
			}
			const presentation = writeLifecyclePresentation(execution.result);
			let exitCode: number = presentation.exitCode;
			if (execution.closeResult?.kind === "failure") {
				exitCode = writeLifecyclePresentation(execution.closeResult).exitCode || 1;
			}
			if (execution.signal !== undefined) exitCode = execution.signal === "SIGINT" ? 130 : 143;
			process.exitCode = exitCode;
		} catch (error) {
			const message =
				error instanceof BreadboardRunConfigError
					? `BreadBoard configuration error [${error.code}/${error.field}]: ${error.message}`
					: error instanceof Error
						? error.message
						: String(error);
			process.stderr.write(`${message}\n`);
			process.exitCode = 1;
		} finally {
			if (!terminalOwnedByDispatch) restoreLifecycleTerminal();
		}
	}
}
