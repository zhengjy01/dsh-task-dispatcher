window.__ModuleLoader__.load({
	id: "dsh-task-dispatcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/** Error carrying the route's JSON error message. */
		var DispatcherApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "DispatcherApiError";
			}
		};
		/** Parse a JSON response or throw a DispatcherApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new DispatcherApiError(`HTTP ${response.status}: invalid JSON response`);
			}
			if (!response.ok) throw new DispatcherApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new DispatcherApiError("网络请求失败: " + String(error instanceof Error ? error.message : error));
			}
			return readJson(response);
		}
		/** The dispatcher panel API. */
		var DispatcherApi = class {
			async getConfig() {
				return request("/api/dsh-task-dispatcher/config");
			}
			async getStatus() {
				return request("/api/dsh-task-dispatcher/status");
			}
			async setConfig(patch) {
				return request("/api/dsh-task-dispatcher/config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async run() {
				return request("/api/dsh-task-dispatcher/run", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({})
				});
			}
			/** List the DSH workspaces the auto-execute worker can run in. */
			async getWorkspaces() {
				return (await request("/api/dsh-task-dispatcher/workspaces")).workspaces;
			}
		};
		//#endregion
		//#region src/client/TaskDispatcherSettingsPanel.tsx
		/**
		* Task-dispatcher settings panel — rendered inside the web settings page
		* (settings.section entry). Configuration form (poll interval, source list,
		* filter, notify toggles, task file) plus a manual dispatch button and the
		* last-pull task list. The panel is self-explanatory: a short intro explains
		* how the dispatcher works, and the task list at the bottom is labelled as a
		* snapshot. Plain React, no emoji, no external UI package — inline styles only.
		*/
		/** Module-level API client (stateless; the component closes over it). */
		const api = new DispatcherApi();
		/** One shared style sheet (kept tiny and theme-agnostic). */
		const s = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				maxWidth: "620px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid rgba(128,128,128,0.3)",
				fontSize: "13px",
				color: "inherit"
			},
			title: {
				fontWeight: 600,
				fontSize: "13px",
				margin: 0
			},
			status: {
				fontSize: "12px",
				opacity: .85
			},
			statusWarn: {
				fontSize: "12px",
				opacity: .9,
				color: "#c9763a"
			},
			hint: {
				fontSize: "12px",
				opacity: .85,
				lineHeight: "1.5",
				margin: 0
			},
			row: {
				display: "flex",
				gap: "6px",
				alignItems: "center"
			},
			label: {
				fontSize: "12px",
				opacity: .85,
				whiteSpace: "nowrap"
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit",
				fontSize: "12px"
			},
			num: {
				width: "72px",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit",
				fontSize: "12px"
			},
			flex: { flex: 1 },
			check: {
				display: "flex",
				gap: "6px",
				alignItems: "center",
				fontSize: "12px"
			},
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "rgba(128,128,128,0.14)",
				color: "inherit",
				fontSize: "12px"
			},
			msg: {
				fontSize: "12px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				opacity: .9
			},
			listHead: {
				fontSize: "12px",
				opacity: .9,
				margin: 0
			},
			list: {
				fontSize: "12px",
				margin: 0,
				paddingLeft: "18px"
			}
		};
		/** Status line for the current config view. */
		function statusText(view) {
			if (view === null) return "加载中…";
			const interval = view.dispatchIntervalMinutes === 0 ? "已关闭定时" : "每 " + view.dispatchIntervalMinutes + " 分钟";
			return (view.enabled ? "已启用" : "已禁用") + " · " + interval + " · 来源「" + view.projectName + "」" + (view.autoExecute ? " · 自动执行" : "") + (view.lastDispatchAt ? " · 上次 " + view.lastDispatchAt + "（" + view.lastTaskCount + " 项）" : " · 尚未拉取");
		}
		/** The settings panel component. */
		function TaskDispatcherSettingsPanel() {
			const [view, setView] = (0, react.useState)(null);
			const [intervalMinutes, setIntervalMinutes] = (0, react.useState)("30");
			const [projectName, setProjectName] = (0, react.useState)("5️⃣AI");
			const [dueMode, setDueMode] = (0, react.useState)("today");
			const [includeUndated, setIncludeUndated] = (0, react.useState)(true);
			const [notifyFlomo, setNotifyFlomo] = (0, react.useState)(true);
			const [flomoTag, setFlomoTag] = (0, react.useState)("AI/DSH/派发");
			const [notifyMac, setNotifyMac] = (0, react.useState)(true);
			const [autoExecute, setAutoExecute] = (0, react.useState)(false);
			const [taskFile, setTaskFile] = (0, react.useState)("");
			const [workspaces, setWorkspaces] = (0, react.useState)([]);
			const [workerWorkspaceId, setWorkerWorkspaceId] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)("");
			const refresh = (0, react.useCallback)(async () => {
				try {
					const v = await api.getStatus();
					setView(v);
					setIntervalMinutes(String(v.dispatchIntervalMinutes));
					setProjectName(v.projectName);
					setDueMode(v.dueMode);
					setIncludeUndated(v.includeUndated);
					setNotifyFlomo(v.notifyFlomo);
					setFlomoTag(v.flomoTag);
					setNotifyMac(v.notifyMac);
					setAutoExecute(v.autoExecute);
					setTaskFile(v.taskFile);
					setWorkerWorkspaceId(v.workerWorkspaceId);
				} catch (error) {
					setMsg("读取状态失败: " + String(error instanceof Error ? error.message : error));
				}
				try {
					setWorkspaces(await api.getWorkspaces());
				} catch (error) {
					setMsg("读取工作区列表失败: " + String(error instanceof Error ? error.message : error));
				}
			}, [api]);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			/** Run one async panel action with busy/message bookkeeping. */
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				try {
					setMsg(await action());
				} catch (error) {
					setMsg("操作失败: " + String(error instanceof Error ? error.message : error));
				} finally {
					setBusy(false);
				}
			};
			const save = () => {
				run(async () => {
					const next = await api.setConfig({
						dispatchIntervalMinutes: Number(intervalMinutes) >= 0 ? Number(intervalMinutes) : 30,
						projectName,
						dueMode,
						includeUndated,
						notifyFlomo,
						flomoTag,
						notifyMac,
						autoExecute,
						workerWorkspaceId,
						...taskFile.trim() !== "" ? { taskFile } : {}
					});
					setView(next);
					return "配置已保存。";
				});
			};
			const dispatchNow = () => {
				run(async () => {
					const result = await api.run();
					setMsg((result.ok ? "[ok] " : "[failed] ") + result.message);
					await refresh();
					return result.ok ? "[ok] " + result.message : "[failed] " + result.message;
				});
			};
			const lastList = view !== null && view.lastTaskTitles.length > 0 ? view.lastTaskTitles : null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: s.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: s.title,
						children: "滴答清单任务派发器"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: s.hint,
						children: [
							"每隔一段间隔，插件会自动从滴答清单「",
							projectName || "来源清单",
							"」拉取今天到期的任务，写入今日任务文件（默认 ~/.dsh/dsh-task-dispatcher/today-tasks.md）；",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "任务有变化时" }),
							"才发 flomo + macOS 通知，没变化则保持安静。 你随手在滴答清单里加任务，插件会在下次拉取时自动带进来。",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "自动执行" }),
							"开启后，每个拉到的新任务会单独开一个 DSH 会话（串行，一任务一会话）去执行，成功即回写滴答清单勾掉。下方的「上次拉取任务列表」只是最近一次拉取到的任务快照，非实时。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: view !== null && view.enabled ? s.status : s.statusWarn,
						children: statusText(view)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: s.label,
								children: "拉取间隔"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: s.num,
								value: intervalMinutes,
								onChange: (e) => setIntervalMinutes(e.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: s.label,
								children: "分钟（0 = 关闭定时自动拉取）"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: s.check,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: autoExecute,
							onChange: (e) => setAutoExecute(e.target.checked)
						}), "自动执行（每个任务单独开一个 DSH 会话去执行，串行）"]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "执行会话工作区"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: {
								...s.input,
								flex: 1
							},
							value: workerWorkspaceId,
							onChange: (e) => setWorkerWorkspaceId(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "默认（用户主目录）"
							}), workspaces.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: w.id,
								children: w.title
							}, w.id))]
						})]
					}),
					autoExecute && workspaces.length > 0 && workerWorkspaceId === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: s.hint,
						children: "提示：开启自动执行后，worker 会话默认在用户主目录下运行；选择上方工作区后，worker 会话会在该工作区目录下运行，并在 GUI 侧边栏归入该工作区。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "来源清单"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							value: projectName,
							onChange: (e) => setProjectName(e.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: s.label,
								children: "过滤"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: {
									...s.input,
									flex: 1
								},
								value: dueMode,
								onChange: (e) => setDueMode(e.target.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "today",
									children: "今天到期/逾期"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "all",
									children: "全部未完成"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: s.check,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: includeUndated,
									onChange: (e) => setIncludeUndated(e.target.checked)
								}), "含无截止"]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: s.check,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: notifyFlomo,
								onChange: (e) => setNotifyFlomo(e.target.checked)
							}), " flomo"]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							value: flomoTag,
							onChange: (e) => setFlomoTag(e.target.value),
							placeholder: "flomo 标签"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: s.check,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: notifyMac,
							onChange: (e) => setNotifyMac(e.target.checked)
						}), " macOS 通知"]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: s.label,
							children: "任务文件"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							value: taskFile,
							onChange: (e) => setTaskFile(e.target.value),
							placeholder: "留空使用默认"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: save,
								disabled: busy,
								children: "保存配置"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: dispatchNow,
								disabled: busy,
								children: "立即拉取"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: () => void refresh(),
								disabled: busy,
								children: "刷新"
							})
						]
					}),
					lastList !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: s.listHead,
						children: "上次拉取任务列表（快照）："
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: s.list,
						children: lastList.map((t, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t }, i))
					})] }),
					msg !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: s.msg,
						children: msg
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		/**
		* Register the dispatcher settings page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "task-dispatcher",
					order: 320,
					label: () => "任务派发器"
				}, TaskDispatcherSettingsPanel));
			} catch (error) {
				console.warn("[dsh-task-dispatcher] settings panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map