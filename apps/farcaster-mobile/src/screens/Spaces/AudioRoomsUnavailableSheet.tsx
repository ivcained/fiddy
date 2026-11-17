import { Octicons } from '@expo/vector-icons';
import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';

import { Text } from '~/components/Text';

const ACTION_PRIMARY = '#7c65c1';

function useColors() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return {
    bg: isDark ? '#1a1a1a' : '#ffffff',
    fg: isDark ? '#ffffff' : '#121212',
    fgFaint: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)',
    border: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
    actionPrimary: ACTION_PRIMARY,
  };
}

type AudioRoomsUnavailableSheetProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Audio rooms — told the truth (the fork's create sheet, honest).
 *
 * This sheet used to be mobile parity with web `CreateSpaceModal`: "Start now"
 * created + joined + navigated through `useStartAudioRoom`, i.e. a write to the
 * fork's `POST /v1/audio-rooms` — the exact request a node-backed client cannot
 * carry ("Fiddy can't do POST /v1/audio-rooms yet", web card t_6b38802b /
 * commit 5c6d3f10, which deleted the web modal and told the truth). The mobile
 * app is unreleased, so nothing leaked, but the seam was still the same 501.
 *
 * This sheet keeps its own name and offers nothing it cannot do: no start, no
 * schedule, no recording toggle (none of those have a Together equivalent, and
 * none may pretend otherwise), and no request is ever fired. A space in Fiddy
 * is a shared board (Together); audio rooms are a hosted product this client
 * cannot make yet.
 */
const AudioRoomsUnavailableSheet: React.FC<AudioRoomsUnavailableSheetProps> =
  React.memo(({ open, onClose }) => {
    const c = useColors();

    return (
      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={onClose}
      >
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={onClose} />
          <View style={[styles.sheet, { backgroundColor: c.bg }]}>
            {/* Grabber */}
            <View style={styles.grabberWrap}>
              <View style={[styles.grabber, { backgroundColor: c.border }]} />
            </View>

            {/* Header */}
            <View style={[styles.header, { borderColor: c.border }]}>
              <View style={styles.headerTitleRow}>
                <Text style={[styles.headerTitle, { color: c.fg }]}>
                  Audio rooms
                </Text>
                <View style={styles.soonBadge}>
                  <Text style={styles.soonBadgeText}>soon</Text>
                </View>
              </View>
              <Pressable onPress={onClose} hitSlop={8}>
                <Octicons name="x" size={20} color={c.fg} />
              </Pressable>
            </View>

            {/* The truth, by this surface's own name. */}
            <View style={styles.body}>
              <Text style={[styles.title, { color: c.fg }]}>
                Audio rooms aren't in Fiddy yet — spaces are shared boards.
              </Text>
              <Text style={[styles.message, { color: c.fgFaint }]}>
                Live audio rooms are hosted by the Farcaster app, and Fiddy
                can't carry one yet — so nothing here starts, schedules or
                records anything, and there is no button pretending otherwise. A
                space in Fiddy is a shared board.
              </Text>
            </View>

            {/* Footer */}
            <View style={[styles.footer, { borderColor: c.border }]}>
              <Pressable
                onPress={onClose}
                style={[
                  styles.gotItButton,
                  { backgroundColor: c.actionPrimary },
                ]}
              >
                <Text style={styles.gotItText}>Got it</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    );
  });

AudioRoomsUnavailableSheet.displayName = 'AudioRoomsUnavailableSheet';

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 24,
  },
  grabberWrap: { alignItems: 'center', paddingTop: 8 },
  grabber: { width: 36, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  soonBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(124,101,193,0.15)',
  },
  soonBadgeText: { color: ACTION_PRIMARY, fontSize: 10, fontWeight: '700' },
  body: { paddingHorizontal: 16, paddingVertical: 20, gap: 8 },
  title: { fontSize: 16, fontWeight: '700' },
  message: { fontSize: 13, lineHeight: 19 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  gotItButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  gotItText: { color: 'white', fontWeight: '700', fontSize: 14 },
});

export { AudioRoomsUnavailableSheet };
