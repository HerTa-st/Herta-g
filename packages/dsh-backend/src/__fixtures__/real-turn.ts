/**
 * One real `sdk-minimal` turn, captured off a live harness (seq 0-16).
 *
 * Fixture rather than a mock: the projection layer's whole job is to survive
 * the shapes the harness actually emits, and the wire format disagrees with
 * the published READMEs in ways only a real capture shows — `tool/call`
 * carries its arguments as a JSON string, notices arrive as
 * `{method, params.event}`, and `turn/end.reason` is `{kind:'completed'}`
 * rather than a boolean. Model prose is truncated; every field used by the
 * projection is verbatim.
 */
import type { DshSessionEvent } from "../events.js";

export const REAL_TURN_EVENTS: readonly DshSessionEvent[] = [
  {
    type: "agent/inbox/spliced",
    seq: 0,
    time: 1789567945528,
    data: {
      target: "next-turn",
      start: 0,
      inserted: [
        {
          content: [
            {
              type: "text",
              text: "Create a file named fixture.txt containing the text ok. Then print the contents of fixture.txt.",
            },
          ],
          source: {
            kind: "user",
          },
          role: "user",
          id: "187e4972-94b4-44c1-8378-1c971b27d06c",
        },
      ],
    },
  },
  {
    type: "turn/start",
    seq: 1,
    time: 1789567945530,
    data: {
      turn: 1,
    },
  },
  {
    type: "agent/inbox/spliced",
    seq: 2,
    time: 1789567945530,
    data: {
      target: "next-turn",
      start: 0,
      removedCount: 1,
      inserted: [],
    },
  },
  {
    type: "step/start",
    seq: 3,
    time: 1789567945532,
    data: {
      turn: 1,
      step: 1,
    },
  },
  {
    type: "system/message",
    seq: 4,
    time: 1789567945534,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "system",
        content: [
          {
            type: "text",
            text: "You are a helpful software engineer assistant.",
          },
        ],
        source: {
          kind: "plugin",
          plugin: "@deepseek-ai/dsh-system-prompt",
        },
        id: "141eec4c-c0ef-4e31-8c1a-7968f2757a5d",
      },
    },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 5,
    time: 1789567945534,
    data: {
      content: [
        {
          type: "text",
          text: "Create a file named fixture.txt containing the text ok. Then print the contents of fixture.txt.",
        },
      ],
      source: {
        kind: "user",
      },
      role: "user",
      id: "187e4972-94b4-44c1-8378-1c971b27d06c",
    },
    surfaceOp: "append",
  },
  {
    type: "request/header",
    seq: 6,
    time: 1789567945535,
    data: {
      header: {
        config: {
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          maxTokens: 256000,
          reasoningEffort: "high",
        },
        adapterDefaults: {
          reasoningEffort: true,
          maxTokens: true,
        },
        tools: [
          {
            name: "pwsh",
            description: "Run commands in a PowerShell shell\n* Whe…",
            parameters: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  description:
                    "The PowerShell command to run. Relative path is preferred in the command.",
                },
              },
              required: ["command"],
            },
          },
        ],
      },
      reason: "initial",
    },
  },
  {
    type: "request/context",
    seq: 7,
    time: 1789567945535,
    data: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      contextWindow: 1000000,
    },
  },
  {
    type: "session/title",
    seq: 8,
    time: 1789567945559,
    data: {
      title: "Create a file named fixture.txt",
      messageSeqs: [5],
      source: {
        kind: "fallback",
      },
    },
  },
  {
    type: "assistant/message",
    seq: 9,
    time: 1789567946552,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "We need respond via tool. Need create fi…",
          },
          {
            type: "tool-call",
            id: "call_00_NlFCUbWhBLIhrAowlii46079",
            name: "pwsh",
            arguments:
              '{"command": "Set-Content -Path fixture.txt -Value \'ok\'; Get-Content -Path fixture.txt"}',
          },
        ],
        source: {
          kind: "model",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
        },
        id: "6dff4c1d-c5b8-4979-8596-df2d005f7ca5",
      },
      usage: {
        inputTokens: 196,
        outputTokens: 121,
        totalTokens: 573,
        cacheReadTokens: 256,
        reasoningTokens: 65,
      },
      stream: [
        {
          type: "chunk",
          time: 1789567946036,
          chunk: {
            type: "block-start",
            index: 0,
            blockType: "reasoning",
          },
        },
        {
          type: "reasoning-chunks",
          time0: 1789567946037,
          index: 0,
          dt: [
            50, 19, 12, 0, 14, 0, 0, 0, 11, 1, 0, 0, 12, 0, 10, 0, 16, 0, 0, 1,
            0, 13, 0, 0, 15, 0, 0, 19, 0, 52, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0,
            11, 0, 0, 0, 14, 0, 0, 20, 0, 35, 0, 0, 0, 0, 0, 9, 0, 0, 0, 1, 14,
            0, 15,
          ],
          texts: [
            "We",
            " need",
            " respond",
            " via",
            " tool",
            ".",
            " Need",
            " create",
            " file",
            " fixture",
            ".txt",
            " containing",
            " text",
            " ok",
            " then",
            " print",
            " contents",
            ".",
            " We",
            " can",
            " use",
            " PowerShell",
            ".",
            " Need",
            " likely",
            " work",
            "dir",
            " persistent",
            "?",
            " Use",
            " Set",
            "-",
            "Content",
            " -",
            "Path",
            " fixture",
            ".txt",
            " -",
            "Value",
            " '",
            "ok",
            "';",
            " Get",
            "-",
            "Content",
            " fixture",
            ".txt",
            ".",
            " Need",
            " ensure",
            " maybe",
            " no",
            " new",
            "line",
            "?",
            ' "',
            "text",
            " ok",
            '"',
            " fine",
            ".",
            " Let",
            "'s",
            " call",
            ".",
          ],
        },
        {
          type: "chunk",
          time: 1789567946443,
          chunk: {
            type: "block-start",
            index: 1,
            blockType: "tool-call",
          },
        },
        {
          type: "tool-call-chunks",
          time0: 1789567946443,
          index: 1,
          dt: [
            0, 0, 0, 0, 0, 18, 0, 0, 1, 0, 14, 0, 0, 0, 1, 0, 16, 0, 0, 0, 0, 0,
            17, 0, 0, 0, 12,
          ],
          id: "call_00_NlFCUbWhBLIhrAowlii46079",
          name: "pwsh",
          args: [
            "",
            "{",
            '"',
            "command",
            '"',
            ": ",
            '"',
            "Set",
            "-",
            "Content",
            " -",
            "Path",
            " fixture",
            ".txt",
            " -",
            "Value",
            " '",
            "ok",
            "';",
            " Get",
            "-",
            "Content",
            " -",
            "Path",
            " fixture",
            ".txt",
            '"',
            "}",
          ],
        },
        {
          type: "chunk",
          time: 1789567946548,
          chunk: {
            type: "block-end",
            index: 0,
            block: {
              type: "reasoning",
              text: "We need respond via tool. Need create fi…",
            },
          },
        },
        {
          type: "chunk",
          time: 1789567946548,
          chunk: {
            type: "block-end",
            index: 1,
            block: {
              type: "tool-call",
              id: "call_00_NlFCUbWhBLIhrAowlii46079",
              name: "pwsh",
              arguments:
                '{"command": "Set-Content -Path fixture.txt -Value \'ok\'; Get-Content -Path fixture.txt"}',
            },
          },
        },
        {
          type: "chunk",
          time: 1789567946548,
          chunk: {
            type: "usage",
            usage: {
              inputTokens: 196,
              outputTokens: 121,
              totalTokens: 573,
              cacheReadTokens: 256,
              reasoningTokens: 65,
            },
          },
        },
        {
          type: "chunk",
          time: 1789567946548,
          chunk: {
            type: "finish",
            reason: {
              kind: "tool-calls",
            },
          },
        },
      ],
    },
    surfaceOp: "append",
  },
  {
    type: "tool/call",
    seq: 10,
    time: 1789567946553,
    data: {
      turn: 1,
      step: 1,
      callId: "call_00_NlFCUbWhBLIhrAowlii46079",
      name: "pwsh",
      arguments:
        '{"command": "Set-Content -Path fixture.txt -Value \'ok\'; Get-Content -Path fixture.txt"}',
    },
  },
  {
    type: "tool/result",
    seq: 11,
    time: 1789567954591,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: {
          kind: "tool",
          callId: "call_00_NlFCUbWhBLIhrAowlii46079",
        },
        content: [
          {
            type: "tool-result",
            toolCallId: "call_00_NlFCUbWhBLIhrAowlii46079",
            content: [
              {
                type: "text",
                text: "ok",
              },
            ],
            isError: false,
          },
        ],
        role: "user",
        id: "c7848eac-5a6a-4318-94cc-7cf86335579c",
      },
    },
    sourceEventSeqs: [10],
    surfaceOp: "append",
  },
  {
    type: "step/end",
    seq: 12,
    time: 1789567954591,
    data: {
      turn: 1,
      step: 1,
    },
  },
  {
    type: "step/start",
    seq: 13,
    time: 1789567954592,
    data: {
      turn: 1,
      step: 2,
    },
  },
  {
    type: "assistant/message",
    seq: 14,
    time: 1789567955277,
    data: {
      turn: 1,
      step: 2,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Created `fixture.txt` containing `ok` and printed its contents:\n\n```text\nok\n```",
          },
        ],
        source: {
          kind: "model",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
        },
        id: "c1abf19d-86b8-4db5-91b8-39dcdd12a4b0",
      },
      usage: {
        inputTokens: 202,
        outputTokens: 22,
        totalTokens: 608,
        cacheReadTokens: 384,
        reasoningTokens: 0,
      },
      stream: [
        {
          type: "chunk",
          time: 1789567955233,
          chunk: {
            type: "block-start",
            index: 0,
            blockType: "text",
          },
        },
        {
          type: "text-chunks",
          time0: 1789567955234,
          index: 0,
          dt: [0, 0, 0, 0, 0, 0, 6, 0, 0, 24, 0, 0, 0, 3, 1, 0, 0, 0, 8, 0],
          texts: [
            "Created",
            " `",
            "fi",
            "xture",
            ".txt",
            "`",
            " containing",
            " `",
            "ok",
            "`",
            " and",
            " printed",
            " its",
            " contents",
            ":\n\n",
            "```",
            "text",
            "\n",
            "ok",
            "\n",
            "```",
          ],
        },
        {
          type: "chunk",
          time: 1789567955276,
          chunk: {
            type: "block-end",
            index: 0,
            block: {
              type: "text",
              text: "Created `fixture.txt` containing `ok` and printed its contents:\n\n```text\nok\n```",
            },
          },
        },
        {
          type: "chunk",
          time: 1789567955276,
          chunk: {
            type: "usage",
            usage: {
              inputTokens: 202,
              outputTokens: 22,
              totalTokens: 608,
              cacheReadTokens: 384,
              reasoningTokens: 0,
            },
          },
        },
        {
          type: "chunk",
          time: 1789567955277,
          chunk: {
            type: "finish",
            reason: {
              kind: "stop",
            },
          },
        },
      ],
    },
    surfaceOp: "append",
  },
  {
    type: "step/end",
    seq: 15,
    time: 1789567955277,
    data: {
      turn: 1,
      step: 2,
    },
  },
  {
    type: "turn/end",
    seq: 16,
    time: 1789567955278,
    data: {
      turn: 1,
      reason: {
        kind: "completed",
      },
    },
  },
];

/** Command the model actually issued in this turn. */
export const REAL_TURN_COMMAND =
  "Set-Content -Path fixture.txt -Value 'ok'; Get-Content -Path fixture.txt";
