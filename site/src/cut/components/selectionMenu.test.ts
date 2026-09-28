import { describe, expect, test } from "bun:test";
import { foldersGoNote, phoneGoNote, pickLabel } from "./selectionMenu";

const folder = { name: "Shoot day" };
const item = { name: "clip.mp4" };

describe("what a confirm calls a pick", () => {
  test("one folder by name, with what it holds in the grid's own word", () => {
    expect(pickLabel([folder], [], ["project", "projects"], 3)).toBe(
      "“Shoot day” and its 3 projects",
    );
    expect(pickLabel([folder], [], ["file", "files"], 1)).toBe("“Shoot day” and its 1 file");
    expect(pickLabel([folder], [], ["item", "items"], 0)).toBe("“Shoot day”");
  });

  test("one item by name", () => {
    expect(pickLabel([], [item], ["file", "files"], 0)).toBe("“clip.mp4”");
  });

  test("counts otherwise, the held count in the same word", () => {
    expect(pickLabel([folder, folder], [item, item, item], ["project", "projects"], 19)).toBe(
      "2 folders (19 projects) and 3 projects",
    );
    expect(pickLabel([folder], [item], ["item", "items"], 0)).toBe("1 folder and 1 item");
  });
});

describe("the sentences a confirm opens with", () => {
  test("a folder note only while the folders hold something", () => {
    expect(foldersGoNote(1, 0)).toBe("");
    expect(foldersGoNote(0, 4)).toBe("");
    expect(foldersGoNote(1, 4)).toBe("Everything inside the folder goes with it. ");
    expect(foldersGoNote(2, 4)).toBe("Everything inside the folders goes with them. ");
  });

  test("a phone note only while something synced from the phone goes", () => {
    expect(phoneGoNote(0, 3)).toBe("");
    expect(phoneGoNote(1, 1)).toBe("It was synced from your phone and is removed there too. ");
    expect(phoneGoNote(1, 3)).toBe("One of them was synced from your phone and is removed there too. ");
    expect(phoneGoNote(2, 3)).toBe("2 of them were synced from your phone and are removed there too. ");
  });
});
