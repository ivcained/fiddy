/** Reduced motion, as the OS reports it, kept current while the app runs. */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export const useReduceMotion = (): boolean => {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) {
        setReduce(enabled);
      }
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => setReduce(enabled),
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduce;
};
