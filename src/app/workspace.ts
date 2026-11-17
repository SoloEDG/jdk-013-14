import { ref } from "vue";
import { createCamera } from "../features/panorama";
import { createPlayback } from "../features/chapters";
import { createDiscovery, type SelectionSnapshot } from "../features/hotspots";
import { createBranch } from "../features/interviews";
import { createJournal } from "../features/journal";
import type { Command, Position } from "../shared/types";
export function createWorkspace() {
  const camera = createCamera(),
    playback = createPlayback(),
    journal = createJournal(),
    discovery = createDiscovery(
      () => playback.state,
      (id) => journal.has(id),
    ),
    branch = createBranch(),
    tab = ref("story");
  /** 进入访谈前的热点选择；返回时只有在仍然有效时才恢复。 */
  let selectionBeforeInterview: SelectionSnapshot | null = null;
  const position = (): Position => ({
    chapterId: playback.state.chapterId,
    time: playback.state.time,
    camera: { ...camera.camera },
    playing: playback.state.playing,
  });
  function enterPerson(id: string) {
    selectionBeforeInterview = discovery.snapshot();
    branch.enter(id, position());
    playback.state.playing = false;
    discovery.collapse();
  }
  function dispatch(command: Command) {
    switch (command.type) {
      case "chapter":
        if (branch.personId.value) return;
        playback.select(command.id);
        camera.reset();
        discovery.close();
        break;
      case "seek":
        playback.seek(command.time);
        break;
      case "hotspot":
        discovery.select(command.id);
        break;
      case "return": {
        const saved = branch.leave();
        if (saved) {
          playback.select(saved.chapterId);
          playback.seek(saved.time);
          camera.restore(saved.camera);
          playback.state.playing = saved.playing;
        }
        // 访谈期间时间窗可能已经走远：恢复前先按当前状态重新分组，
        // 过期成员不可被当成新热点，选择也就不会指向失效内容。
        discovery.sync(camera.camera, { width: 0, height: 0 });
        discovery.restore(selectionBeforeInterview);
        selectionBeforeInterview = null;
        break;
      }
      case "revisit":
        branch.leave();
        playback.select(command.entry.chapterId);
        playback.seek(command.entry.time);
        camera.restore(command.entry.camera);
        discovery.select(command.entry.hotspotId);
        tab.value = "story";
        break;
    }
  }
  function save() {
    const d = discovery.detail.value;
    // 正在阅读的过期成员只能保留历史状态，不能作为新发现写入。
    if (d && d.live) journal.save(d.hotspot, position());
  }
  return {
    camera,
    playback,
    discovery,
    branch,
    journal,
    tab,
    position,
    enterPerson,
    dispatch,
    save,
  };
}
