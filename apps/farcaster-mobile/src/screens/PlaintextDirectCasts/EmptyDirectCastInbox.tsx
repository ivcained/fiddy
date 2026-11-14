import React from 'react';
import { Image, View } from 'react-native';

import { ButtonV2 } from '~/components/ButtonV2';
import { Text2 } from '~/components/Text';
import { useTheme } from '~/contexts/ThemeProvider';

import emptyDark from './emptyDirectCastsDark.png';
import emptyLight from './emptyDirectCastsLight.png';

export function EmptyDirectCastsInbox({
  text = 'No direct casts',
  onStartConversation,
}: {
  text?: string;
  /**
   * Omitted where starting a conversation makes no sense (a search that found
   * nothing), so the same empty state can offer the one thing a person with an
   * empty inbox wants.
   */
  onStartConversation?: () => void;
}) {
  const t = useTheme();

  return (
    <View style={[t.wFull, { marginTop: 20, marginBottom: 28 }, t.itemsCenter]}>
      <View style={[{ marginBottom: 20 }]}>
        <Image
          source={t.dark ? emptyDark : emptyLight}
          style={[{ width: 178, height: 178 }]}
          resizeMode="contain"
        />
      </View>
      <Text2>{text}</Text2>
      {typeof onStartConversation !== 'undefined' && (
        <ButtonV2
          title="New message"
          onPress={onStartConversation}
          variant="primary"
          margin={{ marginTop: 16 }}
          testID="empty-inbox-new-message"
        />
      )}
    </View>
  );
}
