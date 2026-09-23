import { describe, expect, it } from "vitest";

import { findMedia, findMediaAnywhere, renderTemplate, resultError, type TemplateContext } from "../template";

const png = (n: number) => ({ base64: `B${n}`, dataUrl: `data:image/png;base64,B${n}`, url: `https://cdn/u${n}.png`, mime: "image/png" });

function ctx(partial: Partial<TemplateContext> = {}): TemplateContext {
  return { prompt: "a cat", params: {}, spreadParams: [], media: {}, encodings: {}, randomSeed: () => 7, ...partial };
}

describe("renderTemplate", () => {
  it("keeps a whole placeholder's type and interpolates inside text", () => {
    const body = renderTemplate(
      { prompt: "{{prompt}}", n: 1, steps: "{{param.steps}}", note: "run {{param.steps}} steps" },
      ctx({ params: { steps: 30 } })
    );
    expect(body).toEqual({ prompt: "a cat", n: 1, steps: 30, note: "run 30 steps" });
  });

  it("drops keys, items and objects that resolve to nothing", () => {
    const body = renderTemplate(
      { prompt: "{{prompt}}", seed: "{{param.seed}}", config: { ratio: "{{param.ratio}}" }, list: ["{{input.image[0]}}"] },
      ctx()
    );
    expect(body).toEqual({ prompt: "a cat" });
  });

  it("encodes media per handle, and on request", () => {
    const media = { image: [png(1), png(2)] };
    const body = renderTemplate(
      { first: "{{input.image[0]}}", raw: "{{input.image[1].base64}}", all: "{{input.image}}", mime: "{{input.image[0].mime}}" },
      ctx({ media, encodings: { image: "url" } })
    );
    expect(body).toEqual({ first: "https://cdn/u1.png", raw: "B2", all: ["https://cdn/u1.png", "https://cdn/u2.png"], mime: "image/png" });
  });

  it("spreads exposed settings with $params, without overwriting literals", () => {
    const body = renderTemplate(
      { parameters: { watermark: false, $params: true } },
      ctx({ params: { duration: 5, watermark: true, hidden: 1 }, spreadParams: ["duration", "watermark"] })
    );
    expect(body).toEqual({ parameters: { watermark: false, duration: 5 } });
  });

  it("splices $each items beside literal array items", () => {
    const body = renderTemplate(
      {
        content: [
          { type: "text", text: "{{prompt}}" },
          { $each: "input.image", max: 1, item: { type: "image_url", image_url: { url: "{{item}}" }, role: "first_frame" } },
        ],
      },
      ctx({ media: { image: [png(1), png(2)] }, encodings: { image: "dataUrl" } })
    );
    expect(body).toEqual({
      content: [
        { type: "text", text: "a cat" },
        { type: "image_url", image_url: { url: "data:image/png;base64,B1" }, role: "first_frame" },
      ],
    });
  });

  it("fills numbered slots, several groups per object", () => {
    const body = renderTemplate(
      {
        prompt: "{{prompt}}",
        $slots: { $slots: "input.image", keys: ["input_image", "input_image_2"], value: "{{item.base64}}" },
        $slots_mask: { $slots: "input.mask", keys: ["mask"], value: "{{item.base64}}" },
      },
      ctx({ media: { image: [png(1), png(2), png(3)], mask: [png(9)] } })
    );
    expect(body).toEqual({ prompt: "a cat", input_image: "B1", input_image_2: "B2", mask: "B9" });
  });

  it("includes $if branches only when their input has a value", () => {
    const template = { image: { $if: "input.image", then: { bytes: "{{input.image[0].base64}}", mimeType: "{{input.image[0].mime}}" } } };
    expect(renderTemplate(template, ctx())).toEqual({});
    expect(renderTemplate(template, ctx({ media: { image: [png(1)] } }))).toEqual({ image: { bytes: "B1", mimeType: "image/png" } });
  });

  it("uses the injected seed", () => {
    expect(renderTemplate({ seed: "{{random.seed}}" }, ctx())).toEqual({ seed: 7 });
  });

  it("rejects an unknown placeholder instead of sending it", () => {
    expect(() => renderTemplate({ x: "{{nope}}" }, ctx())).toThrow(/Unknown template placeholder/);
  });
});

describe("findMedia", () => {
  it("returns the first URL along the candidate paths", () => {
    expect(findMedia({ data: [{ url: "https://x/y.png" }] }, { media: ["data[0].b64_json|base64:image/png", "data[0].url"] })).toEqual({
      source: "https://x/y.png",
    });
  });

  it("wraps raw base64 with a fixed or a sibling mime", () => {
    expect(findMedia({ data: [{ b64_json: "QQ" }] }, { media: ["data[0].b64_json|base64:image/png"] })?.source).toBe("data:image/png;base64,QQ");
    const gemini = { candidates: [{ content: { parts: [{ text: "hi" }, { inlineData: { mimeType: "image/jpeg", data: "QQ" } }] } }] };
    expect(findMedia(gemini, { media: ["candidates[*].content.parts[*].inlineData.data|base64:@.mimeType"] })?.source).toBe(
      "data:image/jpeg;base64,QQ"
    );
  });

  it("ignores values that are not fetchable (gs://, plain text)", () => {
    expect(findMedia({ video: { uri: "gs://bucket/v.mp4" } }, { media: ["video.uri"] })).toBeNull();
  });

  it("filters array items by a field", () => {
    const result = { output: [{ type: "reasoning", url: "https://x/no" }, { type: "message", url: "https://x/yes" }] };
    expect(findMedia(result, { media: ["output[type=message].url"] })?.source).toBe("https://x/yes");
  });

  it("applies a forced mime type", () => {
    expect(findMedia({ data: [{ url: "https://x/a.svg" }] }, { media: ["data[0].url"], mime: "image/svg+xml" })?.mimeType).toBe("image/svg+xml");
  });
});

describe("resultError", () => {
  const rules = [
    { path: "data.task_status", in: ["failed"], message: "Kling: {@data.task_status_msg}" },
    { path: "status", notIn: ["Ready"], message: "Black Forest Labs: {value}" },
    { path: "error.message" },
  ];

  it("fires on a failed status with the partner's reason", () => {
    expect(resultError({ data: { task_status: "failed", task_status_msg: "content policy" } }, rules)).toBe("Kling: content policy");
  });

  it("fires when a status is present and not a success value", () => {
    expect(resultError({ status: "Content Moderated" }, rules)).toBe("Black Forest Labs: Content Moderated");
  });

  it("stays quiet for missing or empty values", () => {
    expect(resultError({ status: "Ready", error: { message: "" } }, rules)).toBeNull();
    expect(resultError({}, rules)).toBeNull();
  });

  it("drops a trailing separator when the reason is absent", () => {
    expect(resultError({ data: { task_status: "failed" } }, rules)).toBe("Kling");
  });
});

describe("findMediaAnywhere", () => {
  it("finds an output under an alternate provider's own shape", () => {
    const higgsfield = { data: { task_id: "x", task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example.com/a/out.mp4" }] } } };
    expect(findMediaAnywhere(higgsfield, "video")?.source).toBe("https://cdn.example.com/a/out.mp4");
  });

  it("skips echoed inputs and URLs of the wrong kind", () => {
    const result = { input: { image_url: "https://x/in.png" }, first_frame: "https://x/f.png", thumbnail: "https://x/t.jpg", output: { url: "https://x/o.png" } };
    expect(findMediaAnywhere(result, "image")?.source).toBe("https://x/o.png");
    expect(findMediaAnywhere({ output: { url: "https://x/o.png" } }, "video")).toBeNull();
  });
});
