// Public Donkey Vision API contract for POST /api/vision.
// Keep this in sync with src/lib/inference/vision/schema.ts.

export const API_ENDPOINT = {
  method: "POST",
  path: "/api/vision",
  host: "https://donkeycut.com",
} as const;

export type CodeLanguage = {
  key: string;
  label: string;
  code: string;
};

const url = `${API_ENDPOINT.host}${API_ENDPOINT.path}`;

export const CODE_SAMPLES: CodeLanguage[] = [
  {
    key: "typescript",
    label: "TypeScript",
    code: `const res = await fetch("${url}", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.DONKEY_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    // base64 png/jpeg/webp, no "data:" prefix
    image: screenshotBase64,
    instruction: "click the play button",
    returnElements: true,
  }),
});

const { target } = await res.json();
console.log(target.point); // { x, y } — ready to click`,
  },
  {
    key: "python",
    label: "Python",
    code: `import os, requests

res = requests.post(
    "${url}",
    headers={"Authorization": f"Bearer {os.environ['DONKEY_API_KEY']}"},
    json={
        # base64 png/jpeg/webp, no "data:" prefix
        "image": screenshot_base64,
        "instruction": "click the play button",
        "returnElements": True,
    },
)

target = res.json()["target"]
print(target["point"])  # { x, y } — ready to click`,
  },
  {
    key: "swift",
    label: "Swift",
    code: `var request = URLRequest(url: URL(string: "${url}")!)
request.httpMethod = "POST"
request.setValue("Bearer \\(apiKey)", forHTTPHeaderField: "Authorization")
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.httpBody = try JSONSerialization.data(withJSONObject: [
    // base64 png/jpeg/webp, no "data:" prefix
    "image": screenshotBase64,
    "instruction": "click the play button",
    "returnElements": true,
])

let (data, _) = try await URLSession.shared.data(for: request)
let result = try JSONDecoder().decode(VisionResponse.self, from: data)
print(result.target?.point) // { x, y } — ready to click`,
  },
  {
    key: "curl",
    label: "cURL",
    code: `# image is base64 png/jpeg/webp, no "data:" prefix
curl "${url}" \\
  -H "Authorization: Bearer $DONKEY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image": "iVBORw0KGgo...",
    "instruction": "click the play button",
    "returnElements": true
  }'

# target.point in the response is { x, y } — ready to click`,
  },
];

export const RESPONSE_SAMPLE = `{
  "image": { "width": 1440, "height": 900 },
  "elements": [
    {
      "id": "a92kfq",
      "label": "Play",
      "kind": "button",
      "interactive": true,
      "box": { "x": 618, "y": 816, "width": 42, "height": 42 },
      "point": { "x": 639, "y": 837 },
      "confidence": 0.82
    }
  ],
  "target": {
    "elementId": "a92kfq",
    "label": "Play",
    "kind": "button",
    "box": { "x": 618, "y": 816, "width": 42, "height": 42 },
    "point": { "x": 639, "y": 837 },
    "confidence": 0.91
  },
  "alternates": [],
  "model": "gemini-3.1-flash-lite"
}`;

export type ApiField = {
  name: string;
  type: string;
  required?: boolean;
  description: string;
};

export const BODY_PARAMS: ApiField[] = [
  {
    name: "image",
    type: "string",
    required: true,
    description:
      "Base64-encoded screenshot. Supports PNG, JPEG, and WebP. For best results, use JPEG quality `0.8` and resize the longest side to `1568px`.",
  },
  {
    name: "instruction",
    type: "string",
    description:
      "Natural language click instruction, such as `click the play button`. When provided, the response includes a matching click target.",
  },
  {
    name: "model",
    type: "string",
    description:
      "Model used for prompt-based targeting. Supported options include `gemini-3.5-flash` and `gemini-3.1-flash-lite`. Defaults to `gemini-3.1-flash-lite`.",
  },
  {
    name: "returnElements",
    type: "boolean",
    description:
      "Controls whether the full detected element list is returned. Defaults to `true`; disabled automatically when an instruction is provided.",
  },
];

export const RESPONSE_FIELDS: ApiField[] = [
  {
    name: "image",
    type: "object",
    description: "Screenshot dimensions in pixels: `{ width, height }`.",
  },
  {
    name: "elements",
    type: "array",
    description:
      "Detected UI elements. Each element includes `id`, `label`, `kind`, `interactive`, `box`, `point`, and `confidence`. Omitted when `returnElements` is `false`.",
  },
  {
    name: "target",
    type: "object | null",
    description:
      "Best matching click target for the provided instruction. Includes the target element, bounding box, and click point. Returned only when `instruction` is provided.",
  },
  {
    name: "alternates",
    type: "array",
    description:
      "Additional possible matches for the instruction, sorted by confidence.",
  },
  {
    name: "model",
    type: "string",
    description: "Model used for prompt-based target selection.",
  },
];
